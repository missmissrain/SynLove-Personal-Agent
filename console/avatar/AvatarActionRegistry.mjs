/**
 * 欣爱23动作注册与选择器：保存动作清单、根据对话内容给出候选动作并记录当前动作。
 * 注册参数 project 为控制台项目目录；动作配置位于 console/public/Avatar/config/ActionManifest.json，
 * 状态文件位于 runtime/avatarAction.json；默认动作是“基础动作”，切换建议由规则或主模型提供。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class AvatarActionRegistry {
  /** 参数 project 为 SynLove 项目目录；读取动作清单并建立动作索引。 */
  constructor(project) {
    this.project = project
    this.manifestPath = join(project, 'console', 'public', 'Avatar', 'config', 'ActionManifest.json')
    this.statePath = join(project, 'runtime', 'avatarAction.json')
    this.manifest = JSON.parse(readFileSync(this.manifestPath, 'utf8'))
    this.actions = new Map(this.manifest.actions.map(action => [action.name, action]))
    this.defaultAction = this.manifest.defaultAction
    this.state = this.read_state()
  }

  /** 无参数；读取动作状态，文件损坏时回到安全默认状态。 */
  read_state() {
    try {
      if (existsSync(this.statePath)) return JSON.parse(readFileSync(this.statePath, 'utf8'))
    } catch { /* 使用默认状态 */ }
    return { action: this.defaultAction, reason: '启动默认动作', requestId: 0, updatedAt: new Date().toISOString() }
  }

  /** 参数value为状态对象；只保留注册动作，写入给控制台轮询使用。 */
  write_state(value) {
    const next = {
      action: this.actions.has(value.action) ? value.action : this.defaultAction,
      reason: String(value.reason ?? '规则选择').slice(0, 160),
      requestId: Number(value.requestId ?? ((this.state.requestId ?? 0) + 1)),
      updatedAt: new Date().toISOString(),
    }
    this.state = next
    writeFileSync(this.statePath, JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, ...next, metadata: this.actions.get(next.action) }
  }

  /** 参数body为对话文本、情绪、意图和可选主模型动作；返回校验后的动作选择。 */
  choose_action(body = {}) {
    const explicit = String(body.action ?? body.aiAction ?? '').trim()
    if (this.actions.has(explicit)) return this.write_state({ action: explicit, reason: '主模型明确选择' })
    const text = `${body.text ?? ''} ${body.reply ?? ''}`.toLowerCase()
    const emotion = String(body.emotion ?? '').toLowerCase()
    const intent = String(body.intent ?? '').toLowerCase()
    const rules = [
      [['安慰', '难过', '伤心', '委屈', '哭', '失落'], '伸手安慰'],
      [['害怕', '担心', '恐惧', '后退'], '缩肩后退害怕'],
      [['惊讶', '真的吗', '没想到', '震惊'], '睁眼捂嘴惊讶'],
      [['生气', '愤怒', '气死', '讨厌'], '叉腰皱眉生气'],
      [['开心', '高兴', '太好了', '哈哈', '庆祝'], '闭眼拍手开心'],
      [['谢谢', '欢迎', '你好', '打招呼'], '挥手打招呼'],
      [['思考', '分析', '怎么做', '为什么', '考虑'], '托下巴思考'],
      [['听', '收到', '我在听', '语音'], '侧耳倾听'],
      [['困惑', '不明白', '疑惑', '怎么办'], '摊开单手困惑'],
      [['尴尬', '害羞', '不好意思'], '低头碰指害羞'],
      [['擦泪', '眼泪', '泪'], '抬手拭泪伤心'],
      [['展示', '选择', '请看', '给你'], '双臂张开掌心朝上'],
    ]
    for (const [keywords, action] of rules) {
      if (keywords.some(keyword => text.includes(keyword) || emotion.includes(keyword) || intent.includes(keyword))) {
        return this.write_state({ action, reason: `规则命中：${keywords.find(keyword => text.includes(keyword) || emotion.includes(keyword) || intent.includes(keyword))}` })
      }
    }
    return this.write_state({ action: this.defaultAction, reason: '没有可靠语义命中，保持基础动作' })
  }

  /** 无参数；返回动作清单、当前状态及主模型可用的动作选择约束。 */
  snapshot() {
    return {
      ok: true,
      current: this.state,
      defaultAction: this.defaultAction,
      selection: this.manifest.selection,
      actions: this.manifest.actions,
    }
  }
}
