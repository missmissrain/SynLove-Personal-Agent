/** 微信适配器可选媒体依赖声明：部署未安装时由转码层回退原始 SILK。 */

declare module 'silk-wasm' {
  export function decode(input: Uint8Array, sampleRate: number): Promise<{ data: Uint8Array; duration?: number }>
}
