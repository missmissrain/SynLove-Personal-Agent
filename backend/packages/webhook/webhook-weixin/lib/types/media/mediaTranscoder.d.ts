/** 微信语音转码层：尝试 SILK 转 WAV，解码器不可用时保留原始 SILK。 */
/** 尝试用可选 silk-wasm 解码 SILK；失败时返回原始 SILK 和格式标记。 */
export declare function transcode_silk_to_wav(data: Uint8Array, sample_rate?: number): Promise<{
    data: Uint8Array;
    mime_type: 'audio/wav' | 'audio/silk';
    transcoded: boolean;
}>;
//# sourceMappingURL=mediaTranscoder.d.ts.map