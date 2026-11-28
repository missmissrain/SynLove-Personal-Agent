import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export class VoiceTurnBridge {
    resolve;
    prompt;
    server;
    busy = false;
    constructor(resolve, prompt){
        this.resolve = resolve;
        this.prompt = prompt;
    }
    async start_bridge() {
        this.server = createServer(async (req, res)=>{
            const send = (status, value)=>{
                res.writeHead(status, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end(JSON.stringify(value));
            };
            if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, {
                ok: false
            });
            if (req.method === 'GET' && req.url === '/health') {
                try {
                    const agent = await this.resolve();
                    const settings = agent.ctx.get('settings');
                    const routes = agent.ctx.llm.listProviders().map((item)=>item.id);
                    return send(200, {
                        ok: routes.length > 0,
                        busy: this.busy,
                        providers: routes,
                        configuredProviders: Object.keys(settings?.get('llm-pi-ai')?.providers ?? {}),
                        settingsDocument: settings?.documentPath ?? null
                    });
                } catch  {
                    return send(503, {
                        ok: false,
                        error: '主人格未就绪'
                    });
                }
            }
            if (req.method !== 'POST' || req.url !== '/v1/voice/reply') return send(404, {
                ok: false
            });
            if (this.busy) return send(409, {
                ok: false,
                error: '主人格正在处理语音'
            });
            this.busy = true;
            let stage = 'readRequest';
            try {
                const chunks = [];
                let size = 0;
                for await (const part of req){
                    size += part.length;
                    if (size > 32768) throw Error('语音正文过长');
                    chunks.push(part);
                }
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000) throw Error('语音正文无效');
                stage = 'resolveAgent';
                const agent = await this.resolve();
                if (agent.status !== 'idle') return send(409, {
                    ok: false,
                    error: '主人格正在处理其他任务'
                });
                stage = 'prepareTurn';
                const flag = Symbol.for('synlove.voice.turn');
                const key = randomUUID();
                agent[flag] = key;
                const boundary = agent.session.snapshotEvents().length;
                const section = agent.ctx.systemPrompt.section({
                    name: 'synlove:voice-reply',
                    order: 99995,
                    text: ()=>agent[flag] === key ? this.prompt : ''
                });
                let dispose = ()=>{};
                let dispose_error = ()=>{};
                let timer;
                let ended = false;
                try {
                    const done = new Promise((resolve, reject)=>{
                        dispose = agent.ctx.on('session/event', (session, event)=>{
                            if (String(session.id) !== String(agent.id) || event.type !== 'turn/end') return;
                            resolve();
                        });
                        dispose_error = agent.ctx.on('agent/error', ({ agent: subject, error })=>{
                            if (subject === agent) reject(error instanceof Error ? error : Error('主人格执行失败'));
                        });
                        timer = setTimeout(()=>reject(Error('主人格回复超时')), 180000);
                        stage = 'generateReply';
                        agent.followup(createUserMessage({
                            content: [
                                {
                                    type: 'text',
                                    text: body.text.trim()
                                }
                            ],
                            source: {
                                kind: 'user',
                                rpcId: key
                            }
                        }));
                    });
                    await done;
                    ended = true;
                    stage = 'collectReply';
                    const events = agent.session.snapshotEvents().slice(boundary);
                    const end = events.filter((e)=>e.type === 'turn/end').at(-1);
                    const reason = end?.data?.reason;
                    if ((typeof reason === 'string' ? reason : reason?.kind) !== 'completed') throw Error('主人格本轮未正常完成');
                    const last = events.filter((e)=>e.type === 'assistant/message' && e.data.turn === end.data.turn).at(-1);
                    const text = last?.data.message?.content?.filter((p)=>p.type === 'text').map((p)=>p.text).join('\n').trim();
                    if (!text) throw Error('主人格没有返回正文');
                    send(200, {
                        ok: true,
                        reply: text
                    });
                } finally{
                    if (timer) clearTimeout(timer);
                    dispose();
                    dispose_error();
                    if (typeof section === 'function') section();
                    if (ended || agent.status === 'idle') setTimeout(()=>{
                        if (agent[flag] === key) delete agent[flag];
                    }, 0);
                    else {
                        const clean = agent.ctx.on('session/event', (session, event)=>{
                            if (String(session.id) === String(agent.id) && event.type === 'turn/end') {
                                setTimeout(()=>{
                                    if (agent[flag] === key) delete agent[flag];
                                    clean();
                                }, 0);
                            }
                        });
                    }
                }
            } catch (error) {
                const kind = error instanceof Error ? error.name : 'UnknownError';
                const detail = error instanceof Error ? error.message.replace(/sk-[a-zA-Z0-9_-]+|Bearer\s+\S+/g, '[redacted]').slice(0, 160) : '';
                console.error(`[VoiceTurnBridge] ${stage} ${kind}: ${detail}`);
                send(502, {
                    ok: false,
                    error: '主人格语音回合失败',
                    errorStage: stage,
                    errorType: kind
                });
            } finally{
                this.busy = false;
            }
        });
        this.server.requestTimeout = 200000;
        await new Promise((resolve, reject)=>{
            this.server.once('error', reject);
            this.server.listen(8813, '127.0.0.1', resolve);
        });
    }
    stop_bridge() {
        this.server?.close();
    }
}
