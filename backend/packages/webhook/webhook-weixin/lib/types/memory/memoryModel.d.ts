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
/** 用哪个引擎做记忆更新。 */
export type MemoryEngine = 'gemma' | 'cloud';
/** 构造参数。 */
export interface MemoryModelOptions {
    readonly engine: MemoryEngine;
    /** 本地 Gemma 的 OpenAI 兼容根，默认取 GEMMA_LOCAL_BASE_URL。 */
    readonly gemma_base_url?: string;
    /** 本地 Gemma 的模型名。 */
    readonly gemma_model?: string;
    /** 云端模型，写 `provider/model`（例如 `volcengine/doubao-seed-2-0-lite-260215`）。 */
    readonly cloud_model?: string;
    /** modelConfig.json 路径；默认按项目结构推导。 */
    readonly config_path?: string;
    /** 单次调用超时（毫秒），默认 5 分钟（本地冷唤醒要 ~18s，云端可能更慢）。 */
    readonly timeout_ms?: number;
    /** 可注入 fetch，便于测试。 */
    readonly fetch_impl?: typeof fetch;
}
/** 记忆模型客户端。 */
export interface MemoryModel {
    /** 人类可读的引擎说明（写进探针/日志）。 */
    readonly label: string;
    /** 纯文本补全；`max_tokens` 可按需调整（摘要的分块小结只要几百 token）。 */
    complete(prompt: string, max_tokens?: number): Promise<string>;
    /** 图片一句话描述。 */
    describe_image(input: {
        data: Uint8Array;
        media_type: string;
    }): Promise<string>;
}
/** 云端连接信息。 */
interface CloudTarget {
    readonly base_url: string;
    readonly model: string;
    readonly api_key?: string;
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
export declare function resolve_cloud_target(config_path: string, cloud_model: string): CloudTarget | undefined;
/**
 * 创建记忆模型客户端。
 *
 * @param options - 引擎选择与端点参数。
 */
export declare function create_memory_model(options: MemoryModelOptions): MemoryModel;
export {};
//# sourceMappingURL=memoryModel.d.ts.map