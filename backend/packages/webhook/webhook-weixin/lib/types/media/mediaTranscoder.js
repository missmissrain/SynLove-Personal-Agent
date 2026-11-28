function pcm_to_wav(pcm, sample_rate) {
    const result = Buffer.alloc(44 + pcm.byteLength);
    result.write('RIFF', 0);
    result.writeUInt32LE(result.length - 8, 4);
    result.write('WAVE', 8);
    result.write('fmt ', 12);
    result.writeUInt32LE(16, 16);
    result.writeUInt16LE(1, 20);
    result.writeUInt16LE(1, 22);
    result.writeUInt32LE(sample_rate, 24);
    result.writeUInt32LE(sample_rate * 2, 28);
    result.writeUInt16LE(2, 32);
    result.writeUInt16LE(16, 34);
    result.write('data', 36);
    result.writeUInt32LE(pcm.byteLength, 40);
    Buffer.from(pcm).copy(result, 44);
    return result;
}
export async function transcode_silk_to_wav(data, sample_rate = 24_000) {
    try {
        const decoder = await import('silk-wasm');
        const decoded = await decoder.decode(data, sample_rate);
        return {
            data: pcm_to_wav(decoded.data, sample_rate),
            mime_type: 'audio/wav',
            transcoded: true
        };
    } catch  {
        return {
            data,
            mime_type: 'audio/silk',
            transcoded: false
        };
    }
}
