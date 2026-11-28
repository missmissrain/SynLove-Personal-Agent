/**
 * OpenCode命令兼容器：检测实际CLI主版本，把历史调用转换到桌面共享服务协议。
 * 参数bin为已核实的CLI路径；版本探测缓存一分钟，默认保留1.x参数。
 */
import { execFileSync } from 'node:child_process'
export class OpenCodeCommand {
  static cache = new Map<string, { major: number, at: number }>()
  /** bin为真实CLI路径；探测失败抛错，避免向错误版本提交付费任务。 */
  static major_version(bin: string): number {
    const old = this.cache.get(bin)
    if (old && Date.now() - old.at < 60000) return old.major
    const version = execFileSync(bin, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim()
    const match = version.match(/(?:^|\s)(\d+)\.\d+\.\d+/)
    if (!match) throw new Error('无法确认OpenCode CLI版本')
    const major = Number(match[1])
    this.cache.set(bin, { major, at: Date.now() })
    return major
  }
  /** args为历史CLI参数；新版使用用户共享服务，显式server覆盖仍被保留。cwd由调用方传递。 */
  static adapt_args(bin: string, args: string[], configuredServer = process.env.OPENCODE_V2_SERVER_URL
    || (process.env.OPENCODE_SERVER_URL === 'http://127.0.0.1:4096' ? undefined : process.env.OPENCODE_SERVER_URL)): string[] {
    if (this.major_version(bin) < 2) return args
    const out: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dir') { i++; continue }
      if (args[i] === '--attach') {
        i++
        if (configuredServer?.trim()) out.push('--server', configuredServer.trim())
        continue
      }
      out.push(args[i]!)
    }
    if (out[0] === 'export') out.unshift('session')
    return out
  }
}
