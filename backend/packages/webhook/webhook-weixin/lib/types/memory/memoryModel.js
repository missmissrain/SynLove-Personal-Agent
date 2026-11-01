/**
 * 记忆更新的"模型客户端"：本地 Gemma 或云端模型，二者可切换。
 *
 * 为什么需要可切换：本地 Gemma 免费、但要占约 5.3GB 显存（这张卡只有 8GB）。
 * 用户如果在跑游戏/训练，等显存空出来可能要等很久；而记忆更新**不是急事**，
 * 但也不能永远不做。所以给一条"直接用云端模型"的路：不占显存，立刻能跑。
 *
 * 两条路都是 OpenAI 兼容协议，所以这里只实现一个调用器，靠参数区分：
 * - 本地：base_url 指向 llama-server，不需要 key；
 * - 云端：base_url / model / key 从 `config/modelConfig.json` 里取（唯一配置源）。
 *
 * @module dsh-webhook-weixin/memory-model
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probe } from "../diagnostics/probe.js";
/** 默认的云端模型（配置里没有指定时的兜底）。 */
const DEFAULT_CLOUD_MODEL = 'volcengine/doubao-seed-2-0-pro-260215';
/** 项目里 modelConfig.json 的位置（本包 → 项目根 → config）。 */
function default_config_path() {
    // 本文件在 packages/webhook/webhook-weixin/src/memory/ 下
    return join(process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd(), 'config', 'modelConfig.json');
}
/**
 * 从配置解析云端目标；解析不出来返回 undefined。
 *
 * 密钥现在单独放在与 modelConfig.json **同目录的 secrets.json**（见项目 README/启动器说明），
 * 所以这里在两个文件里找 apiKey：模型定义读 modelConfig，密钥读 secrets。
 *
 * @param config_path - modelConfig.json 的路径（secrets.json 按同目录推导）。
 * @param cloud_model - `provider/model` 形式的目标。
 */
export function resolve_cloud_target(config_path, cloud_model) {
    try {
        const config = JSON.parse(readFileSync(config_path, 'utf8'));
        const [provider_id, model_id] = cloud_model.split('/');
        const provider = config.providers?.[provider_id ?? ''];
        if (provider === undefined)
            return undefined;
        const model = model_id !== undefined && model_id !== ''
            ? model_id
            : provider.models?.[0]?.id;
        if (model === undefined || provider.baseURL === undefined)
            return undefined;
        // 密钥优先取 secrets.json；缺文件/缺字段时回退到 modelConfig 里的旧位置
        const api_key = provider.apiKey ?? read_secret_api_key(config_path, provider_id ?? '');
        return {
            base_url: provider.baseURL.replace(/\/$/, ''),
            model,
            ...api_key === undefined ? {} : { api_key },
        };
    }
    catch {
        return undefined;
    }
}
/** 从 `secrets.json`（与配置文件同目录）读某个 provider 的 apiKey；读不到返回 undefined。 */
function read_secret_api_key(config_path, provider_id) {
    try {
        const secrets_path = join(dirname(config_path), 'secrets.json');
        if (!existsSync(secrets_path))
            return undefined;
        const secrets = JSON.parse(readFileSync(secrets_path, 'utf8'));
        const key = secrets.providers?.[provider_id]?.apiKey;
        return typeof key === 'string' && key !== '' ? key : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 创建记忆模型客户端。
 *
 * @param options - 引擎选择与端点参数。
 */
export function create_memory_model(options) {
    const timeout_ms = options?.timeout_ms ?? Number(process.env.SYNLOVE_LLM_TIMEOUT_MS ?? '300000');
    const fetch_impl = options?.fetch_impl ?? fetch;
    const engine = options.engine;
    const config_path = options.config_path ?? default_config_path();
    let base_url;
    let model;
    let api_key;
    let label;
    if (engine === 'cloud') {
        const wanted = options.cloud_model?.trim() || DEFAULT_CLOUD_MODEL;
        const target = resolve_cloud_target(config_path, wanted);
        if (target === undefined) {
            // 配置里找不到就退回本地——总比"记忆永远不更新"好，并留下明显痕迹。
            probe('memory-model', 'cloud.resolve_failed', { wanted, config_path });
            const fallback = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
            base_url = fallback;
            model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M';
            api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY'];
            label = `本地 Gemma（云端 ${wanted} 解析失败，已回退）`;
        }
        else {
            base_url = target.base_url;
            model = target.model;
            api_key = target.api_key;
            label = `云端 ${wanted}`;
        }
    }
    else {
        base_url = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
        model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M';
        api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY'];
        label = `本地 Gemma（${model}）`;
    }
    /** 统一的一次 chat 调用。 */
    const chat = async (content, max_tokens) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout_ms);
        try {
            const response = await fetch_impl(`${base_url}/chat/completions`, {
                redirect: 'error',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...api_key === undefined ? {} : { Authorization: `Bearer ${api_key}` },
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content }],
                    temperature: 0.2,
                    max_tokens,
                    stream: false,
                }),
                signal: controller.signal,
            });
            if (!response.ok)
                throw new Error(`记忆模型 HTTP ${response.status}（${label}）`);
            const parsed = await response.json();
            probe('memory-model', 'completion', {
                label, prompt_tokens: parsed.usage?.prompt_tokens,
                completion_tokens: parsed.usage?.completion_tokens,
            });
            return parsed.choices?.[0]?.message?.content ?? '';
        }
        finally {
            clearTimeout(timer);
        }
    };
    return {
        label,
        complete: (prompt, max_tokens) => chat(prompt, max_tokens ?? 1200),
        describe_image: async (input) => {
            const instruction = '用一句中文描述这张图片的主要内容（谁/什么、在哪、在做什么、明显的文字）。'
                + '只输出这一句话，不要评价、不要客套。';
            return chat([
                { type: 'text', text: instruction },
                {
                    type: 'image_url',
                    image_url: { url: `data:${input.media_type};base64,${Buffer.from(input.data).toString('base64')}` },
                },
            ], 200);
        },
    };
}
//# sourceMappingURL=memoryModel.js.map
