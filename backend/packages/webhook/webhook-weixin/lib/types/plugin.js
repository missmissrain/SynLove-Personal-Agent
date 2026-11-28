import z from '@deepseek-ai/schemastery';
import { probe } from './diagnostics/probe.js';
import { install_weixin_connector } from './runtime/weixinConnector.js';
export const name = 'webhook-weixin';
export const inject = [
    'agents',
    'agentPresets',
    'sessionPersistence'
];
export const Config = z.object({
    base_url: z.string().required(),
    token: z.string().role('secret').required(),
    cdn_base_url: z.string(),
    state_file: z.string(),
    workspace_path: z.string().required(),
    provider: z.string().required(),
    model: z.string().required(),
    reasoning_effort: z.string(),
    agent_preset: z.string(),
    send_retry_count: z.number(),
    send_retry_delay_ms: z.number(),
    state_db: z.string(),
    lease_marker: z.string()
});
export function apply(ctx, config) {
    if (!config.base_url.startsWith('http')) throw new Error('webhook-weixin base_url must be an HTTP URL');
    if (!config.token.trim()) throw new Error('webhook-weixin token must be non-empty');
    probe('lifecycle', 'plugin.apply', {
        base_url: config.base_url,
        preset: config.agent_preset ?? '(default)',
        provider: config.provider,
        model: config.model,
        state_db: config.state_db ?? '(default)'
    });
    install_weixin_connector(ctx, config);
}
