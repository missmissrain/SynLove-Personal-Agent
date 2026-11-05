import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
export class WorkerServiceTools {
    root;
    constructor(root){
        this.root = root;
    }
    service_specs() {
        const bridge = join(this.root, 'config', 'terminalConnection.json');
        let remote = join(this.root, 'remoteControl', 'RemoteCmdMcp.py');
        let args = [];
        if (existsSync(bridge)) {
            const config = JSON.parse(readFileSync(bridge, 'utf8').replace(/^\uFEFF/, ''));
            if (typeof config.repositoryRoot !== 'string' || !config.repositoryRoot) throw Error('终端桥接配置缺少repositoryRoot');
            remote = resolve(this.root, config.repositoryRoot, 'terminalConnection/tools/TerminalMcp.py');
            args = [
                '--config',
                bridge
            ];
        }
        return [
            [
                'remote-cmd',
                remote,
                args,
                360000
            ],
            [
                'reminders',
                join(this.root, 'microServices/ServiceMcpBridge.py'),
                [
                    'reminders'
                ],
                180000
            ],
            [
                'digest',
                join(this.root, 'microServices/ServiceMcpBridge.py'),
                [
                    'digest'
                ],
                1200000
            ],
            [
                'video-digest',
                join(this.root, 'microServices/ServiceMcpBridge.py'),
                [
                    'video'
                ],
                3600000
            ],
            [
                'web-collection',
                join(this.root, 'microServices/ServiceMcpBridge.py'),
                [
                    'crawler'
                ],
                1200000
            ]
        ];
    }
    async mount_tools(child) {
        if (!existsSync(join(this.root, 'config', 'terminalConnection.json')) && !existsSync(join(this.root, 'microServices', 'ServiceMcpBridge.py'))) return 0;
        const python = process.env.SYNLOVE_WORKER_PYTHON || join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        if (!existsSync(python)) throw Error('后台MCP解释器不存在，请配置SYNLOVE_WORKER_PYTHON');
        const specs = this.service_specs();
        let count = 0;
        const unavailable = [];
        for (const [name, file, args, timeout] of specs){
            try {
                if (!existsSync(file)) throw Error('业务MCP入口不存在');
                await McpClient.apply(child, {
                    transport: 'stdio',
                    serverName: name,
                    command: python,
                    args: [
                        file,
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
