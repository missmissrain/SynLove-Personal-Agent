/**
 * 通用软件定位适配器：复用独立终端仓库的软件查找脚本，供编码工具与其他宿主模块统一使用。
 * 参数root默认宿主工作目录；终端仓库位置来自config/terminalConnection.json，解释器可用SYNLOVE_WORKER_PYTHON覆盖。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export class SoftwareLocator {
  static cache = new Map<string, { path: string, at: number }>()
  /** root为实际运行设备的生产根目录，绝不在另一设备代查安装位置。 */
  constructor(private root = process.env.SYNLOVE_ROOT || process.cwd()) {}

  /** name为软件命令名，configured为显式可执行文件；优先配置，查不到时保留命令名及诊断引导。 */
  resolve_command(name: string, configured?: string): string {
    if (configured?.trim() && existsSync(configured.trim())) return configured.trim()
    const key = `${this.root}:${name}`
    const cached = SoftwareLocator.cache.get(key)
    if (cached && Date.now() - cached.at < 60000 && existsSync(cached.path)) return cached.path
    try {
      const file = join(this.root, 'config/terminalConnection.json')
      const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {}
      const repository = resolve(this.root, cfg.repositoryRoot || '../SynLove-Terminal-Connection')
      const script = join(repository, 'terminalConnection/software/SoftwareLocator.py')
      const python = process.env.SYNLOVE_WORKER_PYTHON || join(this.root, '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      if (!existsSync(script) || !existsSync(python)) return name
      const result = JSON.parse(execFileSync(python, ['-X', 'utf8', script, '--name', name], {
        windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
      }))
      // 注册表可能提供GUI启动器，只自动选取命令名匹配的CLI候选，其他交由模型明确核实。
      const candidate = result.candidates?.find((row: any) =>
        (basename(row.path).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() === name.toLowerCase()
          || (row.source === 'managedCli' && name === 'opencode' && /opencode-cli\.exe$/i.test(row.path)))
        && row.source !== 'registry:Uninstall'
        && (row.source === 'managedCli' || !/[/\\]@opencode-aidesktop(?:[.\\/]|\b)/i.test(row.path))
        && !(name.toLowerCase() === 'codex' && !/[/\\]bin[/\\]/i.test(row.path)
          && /[/\\]OpenAI[/\\]Codex[/\\]/i.test(row.path))
        && (process.platform !== 'win32' || /\.(exe|cmd|bat|ps1)$/i.test(row.path))
        && existsSync(row.path))
      if (candidate) SoftwareLocator.cache.set(key, { path: candidate.path, at: Date.now() })
      return candidate?.path ?? name
    } catch { return name }
  }
}
