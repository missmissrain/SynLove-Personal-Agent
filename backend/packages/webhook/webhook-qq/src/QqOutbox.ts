/**
 * QQ 持久发送队列：先原子落盘再发送，逐段记录成功结果，失败保留并有界重试。
 * 参数：path 为独立队列文件；send 为发送函数；report 为状态回调。每条最多重试 5 次。
 * 同一个网关实例拥有该文件；已确认发送的段不会再次发送，未知网络结果仍可能重复。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { QqSendResult, QqSendTarget } from './send.ts'

export interface QqReply {
  id: string
  target: QqSendTarget
  text: string
  msgId?: string
  dedupeKey?: string
  attempt: number
  next_at: number
  status: 'pending' | 'failed_terminal'
  sent_parts: number[]
  error?: string
}

export class QqOutbox {
  private rows: QqReply[] = []
  private draining = false
  private stopped = false
  private receipts: Record<string, string> = {}

  /** path 为队列文件，send 接收消息与分段确认回调，report 只报告脱敏元数据。 */
  constructor(
    private readonly path: string,
    private readonly send: (row: QqReply, mark: (index: number) => void) => Promise<QqSendResult>,
    private readonly report: (state: Record<string, unknown>) => void,
  ) {
    if (!existsSync(path)) return
    const data = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; rows?: QqReply[] }
    if (data.version !== 1 || !Array.isArray(data.rows)
      || data.rows.some(row => typeof row.id !== 'string' || typeof row.text !== 'string'
        || !Array.isArray(row.sent_parts) || typeof row.attempt !== 'number'
        || typeof row.next_at !== 'number' || !row.target
        || !['pending', 'failed_terminal'].includes(row.status))) {
      throw new Error('QQ outbox 文件格式无效，原文件已保留')
    }
    this.rows = data.rows
    this.receipts = (data as any).receipts ?? {}
  }

  /** 无参数；写入临时文件后原子替换，私聊正文只保存在本地状态目录。 */
  private save_rows(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, rows: this.rows, receipts: this.receipts }), { mode: 0o600, flush: true })
    renameSync(temp, this.path)
  }

  /** reply 为完整待发回复；持久化失败会抛出，调用方不得删除内存回复。 */
  enqueue_reply(reply: { text: string; target: QqSendTarget; msgId?: string; dedupeKey?: string }): string {
    if (reply.dedupeKey) {
      const prior = this.receipts[reply.dedupeKey]
        ?? this.rows.find(row => row.dedupeKey === reply.dedupeKey)?.id
      if (prior) return prior
    }
    // 同一入站 msg_id 只允许生成一条被动回复；重试/重复回调直接复用原队列项。
    if (reply.msgId !== undefined) {
      const duplicate = this.rows.find(row =>
        row.msgId === reply.msgId
        && JSON.stringify(row.target) === JSON.stringify(reply.target)
        && row.text === reply.text
        && row.status !== 'failed_terminal')
      if (duplicate !== undefined) return duplicate.id
    }
    if (this.rows.length >= 1024) throw new Error('QQ outbox 已满，待发消息未删除')
    const row: QqReply = {
      ...reply, id: randomUUID(), attempt: 0, next_at: 0, status: 'pending', sent_parts: [],
    }
    this.rows.push(row)
    try { this.save_rows() } catch (error) { this.rows.pop(); throw error }
    return row.id
  }

  /** 无参数；串行发送到期消息，失败保留，防止相同目标后续消息越过失败记录。 */
  async drain_queue(): Promise<void> {
    if (this.draining || this.stopped) return
    this.draining = true
    const blocked = new Set<string>()
    try {
      for (const row of [...this.rows]) {
        if (this.stopped) break
        if (row.status === 'failed_terminal') continue
        const target = JSON.stringify(row.target)
        if (blocked.has(target)) continue
        if (row.next_at > Date.now()) { blocked.add(target); continue }
        let result: QqSendResult
        try {
          result = await this.send(row, index => {
            if (!row.sent_parts.includes(index)) row.sent_parts.push(index)
            this.save_rows()
          })
        } catch (error) { result = { ok: false, mode: 'passive', error: String(error).slice(0, 160) } }
        if (result.ok) {
          if (row.dedupeKey) this.receipts[row.dedupeKey] = row.id
          this.rows.splice(this.rows.indexOf(row), 1)
        } else {
          row.attempt++
          row.error = result.error ?? '发送失败'
          row.next_at = Date.now() + Math.min(300_000, 5_000 * 2 ** row.attempt)
          if (row.attempt >= 5) row.status = 'failed_terminal'
          blocked.add(target)
        }
        this.save_rows()
        this.report({ outbound_id: row.id, ok: result.ok, status: result.ok ? 'sent' : row.status, attempt: row.attempt })
      }
    } finally { this.draining = false }
  }

  /** 无参数；停止取新任务，已经在途的发送仍可持久记录结果。 */
  stop_queue(): void { this.stopped = true }
}
