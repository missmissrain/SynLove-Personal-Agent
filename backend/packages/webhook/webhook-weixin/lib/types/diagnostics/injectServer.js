import { createServer } from 'node:http';
import { probe } from './probe.js';
const MAX_BODY_BYTES = 64 * 1024;
export function start_inject_server(options) {
    const server = createServer((request, response)=>{
        const reply = (status, payload)=>{
            const body = JSON.stringify(payload);
            response.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8'
            });
            response.end(body);
        };
        const path = (request.url ?? '').split('?')[0] ?? '';
        const is_inject = path === '/inject';
        const admin_match = /^\/admin\/([a-z][a-z0-9-]*)$/.exec(path);
        if (request.method !== 'POST' || !is_inject && admin_match === null) {
            reply(404, {
                ok: false,
                error: 'only POST /inject and POST /admin/<action> are supported'
            });
            return;
        }
        if (admin_match !== null && options.admin === undefined) {
            reply(501, {
                ok: false,
                error: 'admin actions are not wired in this build'
            });
            return;
        }
        const chunks = [];
        let size = 0;
        request.on('data', (chunk)=>{
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reply(413, {
                    ok: false,
                    error: 'body too large'
                });
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', ()=>{
            let parsed;
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                parsed = text.trim() === '' ? {} : JSON.parse(text);
            } catch  {
                reply(400, {
                    ok: false,
                    error: 'body must be JSON'
                });
                return;
            }
            if (admin_match !== null) {
                const action = admin_match[1];
                options.admin(action, parsed).then((result)=>reply(200, {
                        ok: true,
                        ...result
                    }), (error)=>{
                    probe('lifecycle', 'admin.failed', {
                        action,
                        error: String(error)
                    });
                    reply(500, {
                        ok: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                });
                return;
            }
            const text = typeof parsed.text === 'string' ? parsed.text : '';
            if (text.trim() === '') {
                reply(400, {
                    ok: false,
                    error: 'text is required'
                });
                return;
            }
            const input = {
                text,
                ...typeof parsed.user_id === 'string' ? {
                    user_id: parsed.user_id
                } : {}
            };
            options.inject(input).then((result)=>reply(200, {
                    ok: true,
                    ...result
                }), (error)=>{
                probe('inbound', 'inject.failed', {
                    error: String(error)
                });
                reply(500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        });
    });
    server.listen(options.port, '127.0.0.1');
    probe('lifecycle', 'inject_server.listening', {
        port: options.port,
        host: '127.0.0.1'
    });
    return server;
}
