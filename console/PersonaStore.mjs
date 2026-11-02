/**
 * 双角色提示词存储：主人格兼容宿主 YAML，执行提示词独立保存，不写固定运行协议。
 * 注册参数 project 为生产根目录，backup 为现有备份函数；不接受客户端指定路径。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class PersonaStore {
  /** project 为固定根目录；backup(path) 在修改前保存原文件。 */
  constructor(project, backup = () => {}) { this.project = project; this.backup = backup }

  /** role 只允许 presenter、worker；将角色映射为唯一已有源文件。 */
  get_path(role) {
    if (!['presenter', 'worker'].includes(role)) throw new Error('未知提示词角色')
    return role === 'worker' ? join(this.project, 'prompts', 'TaskExecution.md')
      : join(this.project, 'config', 'weixinDoubaoProfile.patch.yml')
  }

  /** text 为 YAML 原文；读取主人格块的正文，保留内部空行。 */
  read_block(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    for (let index = 0; index < lines.length; index++) {
      const match = /^(\s*)personaPrefix:\s*[|>]-?\s*$/.exec(lines[index])
      if (!match) continue
      const indent = match[1].length, body = []
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const line = lines[cursor]
        if (line.trim() && line.search(/\S/) <= indent) break
        body.push(line.slice(Math.min(indent + 2, line.length)))
      }
      return body.join('\n').trimEnd()
    }
    throw new Error('配置中找不到 personaPrefix 块')
  }

  /** text 为 YAML 原文，content 为新主人格；只替换目标块，不修改其他部署配置。 */
  write_block(text, content) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    for (let index = 0; index < lines.length; index++) {
      const match = /^(\s*)personaPrefix:\s*[|>]-?\s*$/.exec(lines[index])
      if (!match) continue
      const indent = match[1].length
      let end = index + 1
      while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > indent)) end++
      const body = content.replace(/\r\n/g, '\n').trimEnd().split('\n')
        .map(line => line ? ' '.repeat(indent + 2) + line : '')
      return [...lines.slice(0, index + 1), ...body, ...lines.slice(end)].join(newline)
    }
    throw new Error('配置中找不到 personaPrefix 块，未做修改')
  }

  /** role 为固定角色；读取实际运行源，不建立第二份可漂移的提示词副本。 */
  read_persona(role = 'presenter') {
    const path = this.get_path(role), raw = readFileSync(path, 'utf8')
    return { role, path, text: role === 'worker' ? raw : this.read_block(raw) }
  }

  /** body 含 role、text；校验后备份、原子替换，避免执行器读到写入一半的提示词。 */
  save_persona(body) {
    const role = body.role ?? 'presenter', path = this.get_path(role)
    if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('人格提示词不能为空')
    if (Buffer.byteLength(body.text, 'utf8') > 262144) throw new Error('提示词不能超过256KB')
    const original = readFileSync(path, 'utf8')
    const text = role === 'worker' ? body.text : this.write_block(original, body.text)
    this.backup(path)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
      renameSync(temp, path)
    } finally {
      try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { ok: true, role, note: role === 'worker'
      ? '已保存；下次新建后台任务时生效，运行中的任务不受影响'
      : '已保存主人格；重启 Agent 内核后生效' }
  }
}
