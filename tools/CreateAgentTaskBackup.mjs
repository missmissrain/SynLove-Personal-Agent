/**
 * 任务解耦选择性备份：保存即将修改的源码、编译产物与配置，不复制依赖、模型、聊天库。
 * 注册参数 root 为生产目录；默认版本 v1.0，输出根目录备份/SynLoveAgentTasksv1.0。
 */
import { existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

class CreateAgentTaskBackup {
  /** root 为生产根目录；仅处理固定清单。 */
  constructor(root) { this.root = resolve(root) }

  /** 无参数；创建可恢复的固定范围快照，已有快照时拒绝覆盖。 */
  create_backup() {
    const target = join(this.root, '备份', 'SynLoveAgentTasksv1.0')
    if (existsSync(target)) throw new Error('备份已存在，拒绝覆盖')
    const files = [
      'backend/packages/webhook/webhook-weixin/src', 'backend/packages/webhook/webhook-weixin/lib',
      'backend/packages/webhook/webhook-qq/src', 'backend/packages/webhook/webhook-qq/lib',
      'config/agentPresets', 'config/agentTaskConfig.json', 'config/weixinDoubaoProfile.patch.yml',
      'config/disabledTools.patch.yml', 'config/taskReport.json', 'prompts', 'installer/BootstrapManager.py',
      'remoteControl/RemoteControlRegistration.py', 'taskReport', 'start_stack.py',
      'runtime/dsh/.agent-presets', 'runtime/remoteControl/remoteControl.patch.yml',
    ]
    mkdirSync(target, { recursive: true })
    for (const file of files) {
      const source = join(this.root, file)
      if (existsSync(source)) cpSync(source, join(target, file), {
        recursive: true, filter: path => !/(?:^|[\\/])(?:node_modules|__pycache__|\.venv)(?:[\\/]|$)/.test(path),
      })
    }
    writeFileSync(join(target, '版本记录.json'), JSON.stringify({
      version: '1.0', time: new Date().toISOString(), files, private: true,
    }, null, 2))
    writeFileSync(join(target, '版本说明.md'),
      '# SynLoveAgentTasks v1.0\n\n任务 MCP 与执行会话解耦前的源码、编译产物和配置快照。仅供本机回滚，含私人提示词及配置，不得上传。\n')
    return target
  }
}

console.log(new CreateAgentTaskBackup(process.cwd()).create_backup())
