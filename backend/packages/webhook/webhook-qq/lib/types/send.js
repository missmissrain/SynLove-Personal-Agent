const CHUNK_CHARS = 1200;
export function split_text(text, limit = CHUNK_CHARS) {
    const value = text.trim();
    if (value === '') return [];
    const chunks = [];
    for(let index = 0; index < value.length; index += limit)chunks.push(value.slice(index, index + limit));
    return chunks;
}
export async function send_qq_text(tokenProvider, target, text, msgId, baseUrl = 'https://api.bot.qq.com', progress) {
    const chunks = split_text(text);
    if (chunks.length === 0) return {
        ok: true,
        mode: msgId === undefined ? 'active' : 'passive'
    };
    const scope = target.groupOpenid !== undefined ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages` : target.userOpenid !== undefined ? `/v2/users/${encodeURIComponent(target.userOpenid)}/messages` : undefined;
    if (scope === undefined) return {
        ok: false,
        mode: 'passive',
        error: '没有发送目标（userOpenid / groupOpenid 都为空）'
    };
    const mode = msgId === undefined ? 'active' : 'passive';
    let lastId;
    for (const [index, chunk] of chunks.entries()){
        if (progress?.sent_parts.includes(index)) continue;
        const body = {
            content: chunk,
            msg_type: 0
        };
        if (msgId !== undefined) {
            body.msg_id = msgId;
            body.msg_seq = index + 1;
        }
        try {
            const token = await tokenProvider.get();
            const response = await fetch(`${baseUrl}${scope}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `QQBot ${token}`
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(20_000)
            });
            const raw = await response.text();
            if (!response.ok) return {
                ok: false,
                mode,
                error: `HTTP ${response.status} ${raw.slice(0, 160)}`
            };
            progress?.on_sent(index);
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed.id === 'string') lastId = parsed.id;
            } catch  {}
        } catch (error) {
            return {
                ok: false,
                mode,
                error: String(error).slice(0, 160)
            };
        }
    }
    return {
        ok: true,
        mode,
        ...lastId === undefined ? {} : {
            id: lastId
        }
    };
}
function media_type_of(path) {
    const dot = path.lastIndexOf('.');
    const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
    if ([
        'jpg',
        'jpeg',
        'png',
        'gif',
        'webp',
        'bmp'
    ].includes(ext)) return 1;
    if ([
        'mp4',
        'mov',
        'avi',
        'mkv',
        'webm'
    ].includes(ext)) return 2;
    if ([
        'silk',
        'amr',
        'mp3',
        'wav',
        'ogg',
        'm4a'
    ].includes(ext)) return 3;
    return 4;
}
export async function send_qq_media(tokenProvider, target, filePath, msgId, baseUrl = 'https://api.bot.qq.com') {
    const scope = target.groupOpenid !== undefined ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}` : target.userOpenid !== undefined ? `/v2/users/${encodeURIComponent(target.userOpenid)}` : undefined;
    if (scope === undefined) return {
        ok: false,
        mode: 'passive',
        error: '没有发送目标'
    };
    let data;
    try {
        const { readFile } = await import('node:fs/promises');
        data = await readFile(filePath);
    } catch (error) {
        return {
            ok: false,
            mode: 'passive',
            error: `读取文件失败：${String(error).slice(0, 120)}`
        };
    }
    if (data.byteLength > 20 * 1024 * 1024) {
        return {
            ok: false,
            mode: 'passive',
            error: `文件过大（${(data.byteLength / 1024 / 1024).toFixed(1)}MB，上限 20MB）`
        };
    }
    try {
        const token = await tokenProvider.get();
        const upload = await fetch(`${baseUrl}${scope}/files`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `QQBot ${token}`
            },
            body: JSON.stringify({
                file_type: media_type_of(filePath),
                file_data: data.toString('base64'),
                srv_send_msg: false
            }),
            signal: AbortSignal.timeout(60_000)
        });
        const uploadRaw = await upload.text();
        if (!upload.ok) return {
            ok: false,
            mode: 'passive',
            error: `上传失败 HTTP ${upload.status} ${uploadRaw.slice(0, 160)}`
        };
        const info = JSON.parse(uploadRaw);
        if (typeof info.file_info !== 'string' || info.file_info === '') {
            return {
                ok: false,
                mode: 'passive',
                error: `上传未返回 file_info：${uploadRaw.slice(0, 160)}`
            };
        }
        const send_once = async (passive)=>{
            const body = {
                content: ' ',
                msg_type: 7,
                media: {
                    file_info: info.file_info
                }
            };
            if (passive && msgId !== undefined) {
                body.msg_id = msgId;
                body.msg_seq = 1;
            }
            const response = await fetch(`${baseUrl}${scope}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `QQBot ${token}`
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000)
            });
            const raw = await response.text();
            const mode = passive && msgId !== undefined ? 'passive' : 'active';
            if (!response.ok) return {
                ok: false,
                mode,
                error: `HTTP ${response.status} ${raw.slice(0, 160)}`
            };
            try {
                const parsed = JSON.parse(raw);
                return {
                    ok: true,
                    mode,
                    ...parsed.id === undefined ? {} : {
                        id: parsed.id
                    }
                };
            } catch  {
                return {
                    ok: true,
                    mode
                };
            }
        };
        const first = await send_once(true);
        if (first.ok) return first;
        console.error(`[webhook-qq] 媒体被动发送失败，改主动重试：${first.error ?? ''}`);
        return await send_once(false);
    } catch (error) {
        return {
            ok: false,
            mode: 'passive',
            error: String(error).slice(0, 160)
        };
    }
}
