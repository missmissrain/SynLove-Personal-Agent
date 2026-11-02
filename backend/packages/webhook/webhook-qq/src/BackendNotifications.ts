/**
 * 后台结果本机收件箱。参数home为实例状态根目录；只调用现有QQ出站队列，不另建发送连接。
 * 文件由接收器原子写入；成功持久入队才删除，重启后用稳定dedupeKey防止重复。
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export class BackendNotifications {
  private busy = false
  /** home为当前个人实例状态目录，enqueue为现有队列持久化方法。 */
  constructor(private home: string,
    private enqueue: (row: { text: string; target: { userOpenid: string }; dedupeKey: string }) => unknown) {}

  /** 无参数；串行接收最多20条；写入失败保留文件，下轮继续，不直接发送消息。 */
  async receive_results(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const dir = join(this.home, 'backendNotifications')
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 20)) {
        const path = join(dir, name)
        const row = JSON.parse(readFileSync(path, 'utf8'))
        if (row.id + '.json' !== name || typeof row.text !== 'string' ||
            !row.text.trim() || row.text.length > 30000 || !row.target?.userOpenid) {
          throw new Error('后台通知文件格式无效，原文件已保留')
        }
        await this.enqueue({ text: row.text, target: row.target, dedupeKey: 'backend-' + row.id })
        unlinkSync(path)
      }
    } finally { this.busy = false }
  }
}
