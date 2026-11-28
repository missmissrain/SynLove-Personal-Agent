/**
 * 用本地 Gemma（llama.cpp llama-server）生成时间线摘要。
 *
 * 为什么是本地：摘要只需"读懂一天对话并写几条要点"，Gemma 实测一整天才 ~10 秒，
 * 且免费、不占云端配额。缺点是上下文 32k、长输入会变概括，所以这里对超长的一天
 * 自动走**分块 map-reduce**（分块小结 → 合并）。
 *
 * 显存是懒加载的：llama-server 用 `--sleep-idle-seconds` 启动，空闲后自动把模型
 * 从显存卸下（实测 4.4GB → 0.8GB），下次请求自动唤醒（约 18 秒）。
 * 因此这里的超时必须给足，覆盖"唤醒 + 生成"。
 *
 * @module dsh-webhook-weixin/gemma-summarizer
 */
import type { TimelineAttachment, TimelineSummarizer } from './timelineTypes.ts';
/** 摘要生成参数。 */
export interface GemmaSummarizerOptions {
    /** OpenAI 兼容端点根，默认 `http://127.0.0.1:8080/v1`。 */
    readonly base_url?: string;
    /** 模型名，默认 `gemma-4-E4B-it-Q4_K_M`。 */
    readonly model?: string;
    /** 单次输出上限，默认 600 token。 */
    readonly max_tokens?: number;
    /**
     * 单次请求超时（毫秒），默认 5 分钟。
     *
     * 必须够宽：llama-server 处于休眠时，第一次请求要先把模型读回显存（实测 ~18 秒）。
     */
    readonly timeout_ms?: number;
    /** 超过这个字符数就分块（默认 24000 字符，约 7k token，留足余量）。 */
    readonly chunk_chars?: number;
    /** 可注入的 fetch，便于测试。 */
    readonly fetch_impl?: typeof fetch;
    /**
     * 可注入的"补全"实现：给了就用它，绕过内置的本地 Gemma 直连。
     *
     * 用途：让摘要走**记忆模型客户端**——本地 Gemma 或云端模型由配置决定，
     * 而这里只需关心"给提示词、拿文本"。
     */
    readonly complete?: (prompt: string, max_tokens: number) => Promise<string>;
}
/**
 * 创建 Gemma 摘要器。
 *
 * @param options - 端点与生成参数。
 * @returns 可直接交给 `TimelineStore.summarize_due()` 的摘要器。
 */
export declare function create_gemma_summarizer(options?: GemmaSummarizerOptions): TimelineSummarizer;
/** 图片描述器参数。 */
export interface GemmaImageDescriberOptions extends GemmaSummarizerOptions {
    /** 描述要求（默认一句话，突出可检索的要素）。 */
    readonly instruction?: string;
}
/**
 * 创建"图片一句话描述"生成器（走同一个 llama-server 的视觉通道）。
 *
 * 前置条件：llama-server 必须用 `--mmproj` 载入视觉投影器，否则图片会被忽略或报错。
 * 描述会写进时间线记录，并随当天摘要一起被检索——**原图仍是权威**，
 * 描述只是让"发了什么图"变成可搜索的文本。
 *
 * @param options - 端点与生成参数。
 * @returns 描述函数；输入图片字节与 mime，输出一句话。
 */
export declare function create_gemma_image_describer(options?: GemmaImageDescriberOptions): (input: {
    data: Uint8Array;
    media_type: string;
}) => Promise<string>;
/** 从附件引用里挑出"还没描述"的项，便于回填。 */
export declare function undescribed_attachments(attachments: readonly TimelineAttachment[] | undefined): TimelineAttachment[];
//# sourceMappingURL=gemmaSummarizer.d.ts.map