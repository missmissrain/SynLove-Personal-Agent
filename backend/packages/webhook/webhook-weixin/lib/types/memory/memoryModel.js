import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
const DEFAULT_CLOUD_MODEL = 'volcengine/doubao-seed-2-0-pro-260215';
function default_config_path() {
    return join(process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd(), 'config', 'modelConfig.json');
}
export function resolve_cloud_target(config_path, cloud_model) {
    try {
        const config = JSON.parse(readFileSync(config_path, 'utf8'));
        const cut = cloud_model.indexOf('/');
        const provider_id = cut < 0 ? cloud_model : cloud_model.slice(0, cut);
        const model_id = cut < 0 ? undefined : cloud_model.slice(cut + 1);
        const provider = config.providers?.[provider_id ?? ''];
        if (provider === undefined) return undefined;
        const model = model_id !== undefined && model_id !== '' ? model_id : provider.models?.[0]?.id;
        if (model === undefined || provider.baseURL === undefined) return undefined;
        const api_key = provider.apiKey ?? read_secret_api_key(config_path, provider_id ?? '');
        return {
            base_url: provider.baseURL.replace(/\/$/, ''),
            model,
            ...api_key === undefined ? {} : {
                api_key
            }
        };
    } catch  {
        return undefined;
    }
}
function read_secret_api_key(config_path, provider_id) {
    try {
        const secrets_path = join(dirname(config_path), 'secrets.json');
        if (!existsSync(secrets_path)) return undefined;
        const secrets = JSON.parse(readFileSync(secrets_path, 'utf8'));
        const key = secrets.providers?.[provider_id]?.apiKey;
        return typeof key === 'string' && key !== '' ? key : undefined;
    } catch  {
        return undefined;
    }
}
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
            probe('memory-model', 'cloud.resolve_failed', {
                wanted,
                config_path
            });
            const fallback = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
            base_url = fallback;
            model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M';
            api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY'];
            label = `本地 Gemma（云端 ${wanted} 解析失败，已回退）`;
        } else {
            base_url = target.base_url;
            model = target.model;
            api_key = target.api_key;
            label = `云端 ${wanted}`;
        }
    } else {
        base_url = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
        model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M';
        api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY'];
        label = `本地 Gemma（${model}）`;
    }
const make_chat = (target_base_url, target_model, target_key, target_label) => async (content, max_tokens) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout_ms);
        try {
            const response = await fetch_impl(`${target_base_url}/chat/completions`, {
                redirect: 'error',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...target_key === undefined ? {} : { Authorization: `Bearer ${target_key}` }
                },
                body: JSON.stringify({
                    model: target_model,
                    messages: [{ role: 'user', content }],
                    temperature: 0.2,
                    max_tokens,
                    stream: false
                }),
                signal: controller.signal
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`记忆模型 HTTP ${response.status}（${target_label}）${detail.slice(0, 120)}`);
            }
            const parsed = await response.json();
            probe('memory-model', 'completion', {
                label: target_label,
                prompt_tokens: parsed.usage?.prompt_tokens,
                completion_tokens: parsed.usage?.completion_tokens
            });
            const text = parsed.choices?.[0]?.message?.content;
            if (typeof text !== 'string' || !text.trim())
                throw new Error('记忆模型未返回有效正文，保留原记忆等待重试');
            return text;
        } finally {
            clearTimeout(timer);
        }
    };
    const chat = make_chat(base_url, model, api_key, label);
    const fallback_wanted = engine === 'cloud'
        ? (options.cloud_fallback?.trim() || process.env.DSH_MEMORY_CLOUD_FALLBACK?.trim() || '')
        : '';
    const fallback_target = fallback_wanted === ''
        ? undefined : resolve_cloud_target(config_path, fallback_wanted);
    const fallback_chat = fallback_target === undefined ? undefined
        : make_chat(fallback_target.base_url, fallback_target.model, fallback_target.api_key, `云端备用 ${fallback_wanted}`);
    const complete = async (content, max_tokens) => {
        try {
            return await chat(content, max_tokens);
        } catch (error) {
            if (fallback_chat === undefined)
                throw error;
            probe('memory-model', 'fallback', {
                from: label,
                error: String(error).slice(0, 200)
            });
            return await fallback_chat(content, max_tokens);
        }
    };
    return {
        label,
        complete: (prompt, max_tokens) => complete(prompt, max_tokens ?? 2000),
        describe_image: async (input) => {
            const instruction = '用一句中文描述这张图片的主要内容（谁/什么、在哪/在做什么、明显的文字）。' + '只输出这一句话，不要评价、不要客套。';
            return complete([
                {
                    type: 'text',
                    text: instruction
                },
                {
                    type: 'image_url',
                    image_url: {
                        url: `data:${input.media_type};base64,${Buffer.from(input.data).toString('base64')}`
                    }
                }
            ], 200);
        }
    };
}
