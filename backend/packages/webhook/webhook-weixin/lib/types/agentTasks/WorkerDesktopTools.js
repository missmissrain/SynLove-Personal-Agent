import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
export class WorkerDesktopTools {
    root;
    constructor(root){
        this.root = root;
    }
    read_config() {
        const path = join(this.root, 'config', 'windowsMcpConfig.json');
        if (!existsSync(path)) return undefined;
        const config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
        if (!config.enabled) return undefined;
        const url = new URL(config.url);
        if (![
            'http:',
            'https:'
        ].includes(url.protocol) || url.username || url.password) throw Error('Windows MCP地址格式错误');
        if (url.protocol === 'http:' && ![
            '127.0.0.1',
            'localhost',
            '[::1]'
        ].includes(url.hostname)) throw Error('跨机器Windows MCP必须通过HTTPS或现有安全隧道访问');
        if (typeof config.token !== 'string' || config.token.length < 32) throw Error('Windows MCP缺少独立访问凭据');
        const timeout = config.toolCallTimeoutMs ?? 120000;
        if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 360000) throw Error('Windows MCP超时必须为1000至360000毫秒');
        return {
            ...config,
            url: url.href,
            toolCallTimeoutMs: timeout
        };
    }
    async mount_tools(child) {
        let reason = '未配置Windows桌面MCP';
        try {
            const config = this.read_config();
            if (config) {
                reason = 'Windows桌面MCP连接失败';
                await McpClient.apply(child, {
                    transport: 'streamable-http',
                    serverName: 'windows-mcp',
                    url: config.url,
                    headers: {
                        Authorization: `Bearer ${config.token}`
                    },
                    registerResources: false,
                    failOnStartupError: true,
                    toolCallTimeoutMs: config.toolCallTimeoutMs
                });
                child.systemPrompt.section({
                    name: 'synlove:desktop-target',
                    order: 91,
                    text: 'windows-mcp操作本实例所在电脑的已登录Windows桌面，不是其他终端。先用Snapshot确认窗口和元素，再操作并复查。其他设备使用各自明确授权的远控能力，不混淆目标。'
                });
                return 1;
            }
        } catch  {}
        child.systemPrompt.section({
            name: 'synlove:desktop-unavailable',
            order: 91,
            text: `${reason}。当前不能用Windows桌面工具；不要声称已点击或看见界面，也不要在Session 0用脚本模拟点击来绕过缺失能力。`
        });
        return 0;
    }
}
