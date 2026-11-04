import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
export class WorkerServiceTools {
    root;
    constructor(root){
        this.root = root;
    }
    async mount_tools(child) {
        if (!existsSync(join(this.root, 'remoteControl', 'RemoteCmdMcp.py'))) return 0;
        const python = process.env.SYNLOVE_WORKER_PYTHON || join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        if (!existsSync(python)) throw Error('后台MCP解释器不存在，请配置SYNLOVE_WORKER_PYTHON');
        const specs = [
            [
                'remote-cmd',
                'remoteControl/RemoteCmdMcp.py',
                [],
                240000
            ],
            [
                'reminders',
                'microServices/ServiceMcpBridge.py',
                [
                    'reminders'
                ],
                180000
            ],
            [
                'digest',
                'microServices/ServiceMcpBridge.py',
                [
                    'digest'
                ],
                1200000
            ],
            [
                'video-digest',
                'microServices/ServiceMcpBridge.py',
                [
                    'video'
                ],
                3600000
            ],
            [
                'web-collection',
                'microServices/ServiceMcpBridge.py',
                [
                    'crawler'
                ],
                1200000
            ]
        ];
        let count = 0;
        const unavailable = [];
        for (const [name, file, args, timeout] of specs){
            try {
                await McpClient.apply(child, {
                    transport: 'stdio',
                    serverName: name,
                    command: python,
                    args: [
                        join(this.root, file),
                        ...args
                    ],
                    env: {
                        PYTHONUTF8: '1',
                        PYTHONIOENCODING: 'utf-8',
                        SYNLOVE_SERVICE_CONFIG: join(this.root, 'config', 'serviceConfig.json')
                    },
                    registerResources: false,
                    failOnStartupError: true,
                    toolCallTimeoutMs: timeout
                });
                count++;
            } catch  {
                unavailable.push(name);
            }
        }
        if (unavailable.length) child.systemPrompt.section({
            name: 'synlove:unavailable-services',
            order: 90,
            text: `本轮未能连接这些业务MCP：${unavailable.join('、')}。如任务依赖它们，应如实报告不可用，不得声称执行成功或自行启动替代服务。`
        });
        return count;
    }
}
