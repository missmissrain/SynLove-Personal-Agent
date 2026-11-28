/**
 * 主子Agent思考强度配置：独立JSON保存，两角色默认low，不修改模型、提示词及其他参数。
 * 注册参数project为生产根目录，backup为修改前备份函数；配置从下一次模型请求起读取。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class AgentReasoningStore {
  /** project为固定工程目录，backup默认不执行额外备份；配置文件仅由本地GUI写入。 */
  constructor(project, backup = () => {}) {
    this.path = join(project, 'config', 'agentReasoning.json')
    this.backup = backup
    this.levels = ['low', 'medium', 'high', 'xhigh', 'max']
  }

  /** 无参数；读取两项设置，旧安装未配置时使用low，损坏文件不被静默覆盖。 */
  read_config() {
    let data
    try { data = JSON.parse(readFileSync(this.path, 'utf8').replace(/^\uFEFF/, '')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; data = {} }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('思考强度配置格式无效')
    return Object.fromEntries(['presenter', 'worker'].map(role => {
      const value = data[role] ?? 'low'
      if (!this.levels.includes(value)) throw new Error('思考强度配置值无效')
      return [role, value]
    }))
  }

  /** 无参数；返回即时生效的两项下拉选项，明确模型能力约束。 */
  list_controls() {
    const data = this.read_config()
    const names = { low: '低 · low', medium: '中 · medium', high: '高 · high', xhigh: '很高 · xhigh', max: '最高 · max' }
    return ['presenter', 'worker'].map(role => ({
      key: `reasoning.${role}`, label: role === 'presenter' ? '主 Agent 思考强度' : '子 Agent 思考强度',
      kind: 'select', value: data[role],
      options: this.levels.map(value => ({ value, label: names[value] })),
      help: '下一次模型调用生效；不影响正在生成的回复。模型不支持所选档位时使用该模型的默认设置。',
    }))
  }

  /** role为presenter或worker，value为允许档位；原子保存单项并保留另一角色。 */
  save_setting(role, value) {
    if (!['presenter', 'worker'].includes(role) || !this.levels.includes(value))
      throw new Error('未知角色或思考强度')
    const data = this.read_config()
    data[role] = value
    this.backup(this.path)
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', flush: true })
      renameSync(temp, this.path)
    } finally {
      try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { ok: true, value, note: '已保存，下一次模型调用生效' }
  }
}
