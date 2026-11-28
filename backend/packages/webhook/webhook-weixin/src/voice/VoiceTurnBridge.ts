/**
 * 功能：在现有主人格进程内提供语音回合入口，复用共享会话、工具与记忆。
 * 注册参数resolve为主人格解析函数，prompt为独立提示词；默认仅监听回环8813。
 */
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export class VoiceTurnBridge {
  private server?: Server
  private busy = false
  /** resolve返回已挂载主人格，prompt为语音下行约定；不接受远端会话选择。 */
  constructor(private resolve: () => Promise<any>, private prompt: string) {}

  /** 无参数；启动仅供本机语音网关调用的入口，拒绝浏览器来源与任意路径。 */
  async start_bridge(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
        res.end(JSON.stringify(value))
      }
      if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403,{ok:false})
      if (req.method === 'GET' && req.url === '/health') {
        try {
          const agent = await this.resolve()
          const settings = agent.ctx.get('settings')
          const routes = agent.ctx.llm.listProviders().map((item: any) => item.id)
          return send(200,{ok:routes.length > 0,busy:this.busy,providers:routes,
            configuredProviders:Object.keys(settings?.get('llm-pi-ai')?.providers ?? {}),
            settingsDocument:settings?.documentPath ?? null})
        } catch { return send(503,{ok:false,error:'主人格未就绪'}) }
      }
      if (req.method !== 'POST' || req.url !== '/v1/voice/reply') return send(404,{ok:false})
      if (this.busy) return send(409,{ok:false,error:'主人格正在处理语音'})
      this.busy = true
      let stage = 'readRequest'
      try {
        const chunks: Buffer[] = []; let size = 0
        for await (const part of req) {
          size += part.length
          if (size > 32768) throw Error('语音正文过长')
          chunks.push(part)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000)
          throw Error('语音正文无效')
        stage = 'resolveAgent'
        const agent = await this.resolve()
        if (agent.status !== 'idle') return send(409,{ok:false,error:'主人格正在处理其他任务'})
        stage = 'prepareTurn'
        const is_text = body.mode === 'text'
        const flag = Symbol.for('synlove.voice.turn')
        const key = randomUUID()
        ;(agent as any)[flag] = key
        const boundary = agent.session.snapshotEvents().length
        const section = agent.ctx.systemPrompt.section({
          name:'synlove:voice-reply',order:99995,
          text:() => (agent as any)[flag] === key ? (is_text ? '' : this.prompt) : '',
        })
        let dispose: () => void = () => {}
        let dispose_error: () => void = () => {}
        let timer: ReturnType<typeof setTimeout> | undefined
        let ended = false
        try {
          const done = new Promise<void>((resolve, reject) => {
            dispose = agent.ctx.on('session/event', (session: any, event: any) => {
              if (String(session.id) !== String(agent.id) || event.type !== 'turn/end') return
              resolve()
            })
            dispose_error = agent.ctx.on('agent/error', ({agent: subject,error}: any) => {
              if (subject === agent) reject(error instanceof Error ? error : Error('主人格执行失败'))
            })
            timer = setTimeout(() => reject(Error('主人格回复超时')),180000)
            stage = 'generateReply'
            agent.followup(createUserMessage({
              content:[{type:'text',text:body.text.trim()}],
              source:{kind:'user',rpcId:key},
            }))
          })
          await done
          ended = true
          stage = 'collectReply'
          const events = agent.session.snapshotEvents().slice(boundary)
          const end = events.filter((e: any) => e.type === 'turn/end').at(-1)
          const reason = end?.data?.reason
          if ((typeof reason === 'string' ? reason : reason?.kind) !== 'completed')
            throw Error('主人格本轮未正常完成')
          const last = events.filter((e: any) => e.type === 'assistant/message'
            && e.data.turn === end.data.turn).at(-1)
          const text = last?.data.message?.content?.filter((p: any) => p.type === 'text')
            .map((p: any) => p.text).join('\n').trim()
          if (!text) throw Error('主人格没有返回正文')
          send(200,{ok:true,reply:text})
        } finally {
          if (timer) clearTimeout(timer)
          dispose()
          dispose_error()
          if (typeof section === 'function') section()
          // 超时仍在运行时不清标记，避免迟到的语音回复被投到微信或QQ。
          if (ended || agent.status === 'idle') setTimeout(() => {
            if ((agent as any)[flag] === key) delete (agent as any)[flag]
          },0)
          else {
            const clean = agent.ctx.on('session/event',(session: any,event: any) => {
              if (String(session.id) === String(agent.id) && event.type === 'turn/end') {
                setTimeout(() => { if ((agent as any)[flag] === key) delete (agent as any)[flag]; clean() },0)
              }
            })
          }
        }
      } catch (error) {
        // 仅在私有运行日志记录内部故障；不记录录音、用户正文或提示词。
        const kind = error instanceof Error ? error.name : 'UnknownError'
        const detail = error instanceof Error ? error.message.replace(/sk-[a-zA-Z0-9_-]+|Bearer\s+\S+/g,'[redacted]').slice(0,160) : ''
        console.error(`[VoiceTurnBridge] ${stage} ${kind}: ${detail}`)
        send(502,{ok:false,error:'主人格语音回合失败',errorStage:stage,errorType:kind})
      }
      finally { this.busy = false }
    })
    this.server.requestTimeout = 200000
    await new Promise<void>((resolve,reject) => {
      this.server!.once('error',reject)
      this.server!.listen(8813,'127.0.0.1',resolve)
    })
  }

  /** 无参数；停止接收新语音，跟随主人格实例释放端口。 */
  stop_bridge(): void { this.server?.close() }
}
