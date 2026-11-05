/**
 * 后台业务工具装配：为全部执行任务挂载固定远控与业务MCP，不按任务类别裁剪。
 * 参数root为生产根目录；解释器默认本项目.venv，SYNLOVE_WORKER_PYTHON可显式覆盖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export class WorkerServiceTools {
  /** root为所属个人实例目录；不使用模型或任务文本指定连接端点。 */
  constructor(private root: string) {}

  /** 无参数；按桥接配置解析独立终端仓库入口，避免使用已从主仓库移走的旧远控文件。 */
  service_specs(): Array<[string, string, string[], number]> {
    const bridge = join(this.root, 'config', 'terminalConnection.json')
    let remote = join(this.root, 'remoteControl', 'RemoteCmdMcp.py')
    let args: string[] = []
    if (existsSync(bridge)) {
      const config = JSON.parse(readFileSync(bridge, 'utf8').replace(/^\uFEFF/, ''))
      if (typeof config.repositoryRoot !== 'string' || !config.repositoryRoot)
        throw Error('终端桥接配置缺少repositoryRoot')
      remote = resolve(this.root, config.repositoryRoot, 'terminalConnection/tools/TerminalMcp.py')
      args = ['--config', bridge]
    }
    return [
      ['remote-cmd', remote, args, 360000],
      ['reminders', join(this.root, 'microServices/ServiceMcpBridge.py'), ['reminders'], 180000],
      ['digest', join(this.root, 'microServices/ServiceMcpBridge.py'), ['digest'], 1200000],
      ['video-digest', join(this.root, 'microServices/ServiceMcpBridge.py'), ['video'], 3600000],
      ['web-collection', join(this.root, 'microServices/ServiceMcpBridge.py'), ['crawler'], 1200000],
    ]
  }

  /** child为独立执行上下文；返回本轮成功挂载的MCP数量，服务离线仍如实说明。 */
  async mount_tools(child: any): Promise<number> {
    // 仅正式安装有桥接入口；隔离测试可以仅提供任务运行器，不要求整套生产目录。
    if (!existsSync(join(this.root, 'config', 'terminalConnection.json')) &&
        !existsSync(join(this.root, 'microServices', 'ServiceMcpBridge.py'))) return 0
    const python = process.env.SYNLOVE_WORKER_PYTHON ||
      join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (!existsSync(python)) throw Error('后台MCP解释器不存在，请配置SYNLOVE_WORKER_PYTHON')
    const specs = this.service_specs()
    let count = 0
    const unavailable: string[] = []
    for (const [name, file, args, timeout] of specs) {
      try {
        if (!existsSync(file)) throw Error('业务MCP入口不存在')
        await McpClient.apply(child, {
          transport: 'stdio', serverName: name, command: python,
          args: [file, ...args],
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
