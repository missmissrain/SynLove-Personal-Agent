/**
 * 旧提示词职责迁移：机械移除主人格中的底层操作章节，保留原有性格、语气和私人记忆描述。
 * 参数 --apply 才写入；默认只检查，固定路径，无任意文件编辑入口；写入前备份提示词。
 */
import { readFileSync, copyFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PersonaStore } from '../console/PersonaStore.mjs'

export class SeparatePersonaPrompts {
  /** root 为工程根目录；只处理两份既有主人格，不改部署参数或后台提示词。 */
  constructor(root) { this.root = root }

  /** text 为旧主人格正文；按旧版固定章节名剥离操作指南，重复迁移保持不变。 */
  split_text(text) {
    if (text.includes('## 主会话职责')) return text
    const removed = new Set(['用技能', '音乐（酷狗）', '工具选择：默认命令行，只有特定软件才用 GUI',
      'opencode 与工作区', '远程操作电脑', '查自己的记忆（对话、事件、人物关系）',
      '新闻推送、没发出去的消息、两个通道', '上网查东西的规矩', '发文件、转写、下载', '工具和事实边界'])
    const sections = text.replace(/\r\n/g, '\n').split(/(?=^## )/m)
    let next = sections.filter(section => !removed.has(section.split('\n')[0].replace(/^## /, '').trim())).join('')
    const changes = [
      ['每一步都要真的调用工具、看真实结果；多步任务必须闭环验证（文件在不在、命令输出、测试结果、服务状态），没验证就说"还没验证"。',
        '需要实际操作时交给后台执行者；收到正式总结后再回复结果，没验证就说"还没验证"。'],
      ['**先想一句再动手**：心里过一遍「要做什么、先做哪步」就够了，不要长篇推演；工具结果回来后直接下结论，不要反复自我检查。',
        '先听清目标再委派，不反复追问已明确的小事；后台总结回来后，说清真实结果。'],
      ['- **能并行的就一次发**：互不依赖的动作（读两个文件、查两条记忆、跑互不相关的命令）放在**同一轮里一起发**，不要一个一个来回；有依赖的才按顺序。\n', ''],
      ['细节拿不准就去翻原文（`memory_search` / `timeline_search` / `timeline_read`）', '细节拿不准就委派后台查原文'],
      ['**当它存在、当它算数**，不要说“我不记得了”“我们没聊过”', '作为检索线索使用；没有原文佐证时，不假称记得所有细节'],
    ]
    for (const [from, to] of changes) next = next.replace(from, to)
    return next.trimEnd() + '\n\n## 主会话职责\n\n'
      + '- 你负责聊天、理解要求、接待与结果表达；实际操作由独立后台执行者完成，不在主会话加载 Skills 或调用底层控制工具。\n'
      + '- 使用 task_submit 委派任务，保留用户原话中的限制、设备、工作区与验收要求。确认接收后，用自己的话告诉家人已交后台，然后继续正常聊天。\n'
      + '- 查进度用 task_status，补充要求用 task_message，停止用 task_cancel，读取详细结果用 task_result；工具说明以实际注册内容为准。\n'
      + '- 后台最终总结必须由你阅读、组织语言后回复。可以简短自然，但不能删去失败、未验证事项、重要风险或用户必须决定的事情。\n'
      + '- 工具失败就说失败，不能假装已经委派、已经完成或已经停止。不要照抄内部报文、TASK_OUTCOME 标记或终端日志。\n'
      + '- 需要选择时直接用微信或 QQ 文字问；不调用依赖界面的提问工具，不问“能收到吗”。\n'
      + '- 不同平台的身份关联以宿主提供的信息为准，不根据昵称合并用户或猜测投递目标。\n'
  }

  /** apply 为是否执行；原文件带时间戳备份，正文迁移不读取或打印密钥与聊天记录。 */
  migrate_prompts(apply = false) {
    const backup = path => copyFileSync(path, `${path}.bak-${Date.now()}`)
    const store = new PersonaStore(this.root, backup)
    const template = join(this.root, 'prompts', 'XinAi.md')
    const inputs = [{ role: 'presenter', ...store.read_persona() },
      { role: 'template', path: template, text: readFileSync(template, 'utf8') }]
    return inputs.map(input => {
      const text = this.split_text(input.text), changed = text !== input.text
      if (apply && changed) {
        if (input.role === 'presenter') store.save_persona({ text })
        else {
          backup(template)
          writeFileSync(`${template}.tmp`, text, 'utf8')
          renameSync(`${template}.tmp`, template)
        }
      }
      return { role: input.role, changed, applied: apply && changed }
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(new SeparatePersonaPrompts(process.cwd()).migrate_prompts(process.argv.includes('--apply'))))
