import { createServer } from 'node:http';
export function start_qq_admin_server(options) {
    const server = createServer((request, response) => {
        const reply = (status, payload) => {
            const body = JSON.stringify(payload);
            response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(body);
        };
        if (request.method !== 'POST' || (request.url ?? '').split('?')[0] !== '/send') {
            reply(404, {
                ok: false,
                error: 'only POST /send is supported'
            });
            return;
        }
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            }
            catch {
                reply(400, {
                    ok: false,
                    error: 'body must be JSON'
                });
                return;
            }
            const text = typeof body.text === 'string' ? body.text.trim() : '';
            if (text === '' || body.target === undefined) {
                reply(400, {
                    ok: false,
                    error: 'text and target are required'
                });
                return;
            }
            const msgId = typeof body.msgId === 'string' && body.msgId !== '' ? body.msgId : undefined;
            options.send(text, body.target, msgId).then((result)=>reply(result.ok ? 200 : 502, result), (error)=>reply(500, {
                    ok: false,
                    error: String(error).slice(0, 200)
                }));
        });
    });
    server.listen(options.port, '127.0.0.1');
    return server;
}
