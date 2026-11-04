/**
 * 后台业务工具装配：为全部执行任务挂载固定远控与业务MCP，不按任务类别裁剪。
 * 参数root为生产根目录；解释器默认本项目.venv，SYNLOVE_WORKER_PYTHON可显式覆盖。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export class WorkerServiceTools {
  /** root为所属个人实例目录；不使用模型或任务文本指定连接端点。 */
  constructor(private root: string) {}

  /** child为独立执行上下文；返回本轮成功挂载的MCP数量，服务离线仍如实说明。 */
  async mount_tools(child: any): Promise<number> {
    // 仅正式安装有桥接入口；隔离测试可以仅提供任务运行器，不要求整套生产目录。
    if (!existsSync(join(this.root, 'remoteControl', 'RemoteCmdMcp.py'))) return 0
    const python = process.env.SYNLOVE_WORKER_PYTHON ||
      join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (!existsSync(python)) throw Error('后台MCP解释器不存在，请配置SYNLOVE_WORKER_PYTHON')
    const specs = [
      ['remote-cmd', 'remoteControl/RemoteCmdMcp.py', [], 240000],
      ['reminders', 'microServices/ServiceMcpBridge.py', ['reminders'], 180000],
      ['digest', 'microServices/ServiceMcpBridge.py', ['digest'], 1200000],
      ['video-digest', 'microServices/ServiceMcpBridge.py', ['video'], 3600000],
      ['web-collection', 'microServices/ServiceMcpBridge.py', ['crawler'], 1200000],
    ] as const
    let count = 0
    const unavailable: string[] = []
    for (const [name, file, args, timeout] of specs) {
      try {
        await McpClient.apply(child, {
          transport: 'stdio', serverName: name, command: python,
          args: [join(this.root, file), ...args],
          env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
            SYNLOVE_SERVICE_CONFIG: join(this.root, 'config', 'serviceConfig.json') },
          registerResources: false, failOnStartupError: true, toolCallTimeoutMs: timeout,
        } as any)
        count++
      } catch {
        // 单个可选业务离线不能阻止独立远控；明确告知执行者缺失能力，不回退其他设备。
        unavailable.push(name)
      }
    }
    if (unavailable.length) child.systemPrompt.section({
      name: 'synlove:unavailable-services', order: 90,
      text: `本轮未能连接这些业务MCP：${unavailable.join('、')}。如任务依赖它们，应如实报告不可用，不得声称执行成功或自行启动替代服务。`,
    })
    return count
  }
}
