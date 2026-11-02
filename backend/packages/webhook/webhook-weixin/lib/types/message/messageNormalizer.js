const MAX_MEDIA_BYTES = Number(process.env.DSH_WEIXIN_MAX_MEDIA_BYTES ?? String(20 * 1024 * 1024));
export class MessageNormalizer {
    normalize_message(message) {
        const user_id = message.from_user_id ?? '';
        if (!user_id) throw new Error('iLink message has no from_user_id');
        const items = message.item_list ?? [];
        const text_parts = [];
        const media = [];
        for (const item of items)this.normalize_item(item, text_parts, media);
        const delivery_id = String(message.message_id ?? message.seq ?? `${user_id}:${message.create_time_ms ?? Date.now()}`);
        return {
            delivery_id,
            user_id,
            ...message.context_token === undefined ? {} : {
                context_token: message.context_token
            },
            text: text_parts.join('\n').trim(),
            media,
            received_at: message.create_time_ms ?? Date.now()
        };
    }
    async hydrate_media(message, loader) {
        for (const media of message.media){
            if (media.data || !media.media || media.kind === 'voice' && media.source_text !== 'voice_media_requires_asr') continue;
            const declared = media.media.rawsize ?? media.media.filesize;
            if (typeof declared === 'number' && declared > MAX_MEDIA_BYTES) {
                media.source_text = `媒体过大已跳过（${Math.round(declared / 1024 / 1024)}MB > 上限 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB）`;
                continue;
            }
            media.data = await loader(media.media);
            if (media.data.length > MAX_MEDIA_BYTES) {
                delete media.data;
                media.source_text = `媒体过大已跳过（>${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB）`;
                continue;
            }
            if (media.kind === 'voice') {
                media.raw_data = media.data;
                const { transcode_silk_to_wav } = await import('../media/mediaTranscoder.js');
                const converted = await transcode_silk_to_wav(media.data);
                media.data = converted.data;
                media.mime_type = converted.mime_type;
                media.transcoded = converted.transcoded;
            }
            if (media.kind === 'image' && media.mime_type === undefined) media.mime_type = 'image/jpeg';
        }
        return message;
    }
    normalize_item(item, text_parts, media) {
        if (item.type === 1 && item.text_item?.text !== undefined) text_parts.push(item.text_item.text);
        if (item.type === 2 && item.image_item) media.push({
            kind: 'image',
            mime_type: 'image/jpeg',
            name: 'weixin-image.jpg',
            media: {
                ...item.image_item.media,
                ...item.image_item.aeskey === undefined ? {} : {
                    aes_key: Buffer.from(item.image_item.aeskey, 'hex').toString('base64')
                }
            }
        });
        if (item.type === 3 && item.voice_item) {
            if (item.voice_item.text) text_parts.push(item.voice_item.text);
            else media.push({
                kind: 'voice',
                mime_type: 'audio/silk',
                source_text: 'voice_media_requires_asr',
                ...item.voice_item.media === undefined ? {} : {
                    media: item.voice_item.media
                }
            });
        }
        if (item.type === 4 && item.file_item) media.push({
            kind: 'file',
            ...item.file_item.file_name === undefined ? {} : {
                name: item.file_item.file_name
            },
            mime_type: 'application/octet-stream',
            ...item.file_item.media === undefined ? {} : {
                media: item.file_item.media
            }
        });
    }
}
