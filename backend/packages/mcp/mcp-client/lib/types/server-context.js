// MCP 上下文注册：registerResources 默认开启；任务专用服务可关闭资源工具，仍保留服务说明。
/**
 * Publish connection-owned MCP resources and literal server instructions.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */
/**
 * Contribute server context to the services enabled by this composition.
 * @param ctx - server plugin's registration scope and effect owner.
 * @param server - configured server identity.
 * @param connection - live resource operations and successful instruction snapshot.
 */
export function registerServerContext(ctx, server, connection, registerResources = true) {
    if (registerResources) ctx.inject(['mcpResources'], (inner) => {
        inner.mcpResources.register(server, connection.resources);
    });
    ctx.inject(['systemPrompt'], (inner) => {
        inner.systemPrompt.section({
            name: `mcp:${server}`,
            order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
            interpolate: false,
            text: () => connection.instructions(),
        });
    });
}
//# sourceMappingURL=server-context.js.map
