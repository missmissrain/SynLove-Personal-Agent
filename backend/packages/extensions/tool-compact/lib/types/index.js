/**
 * 工具表压缩 + 按需参数查询（参考 AI剪辑 的工具层设计）。
 *
 * 模型看到的东西只有两样：
 *  1) **工具名 + 一行摘要**（不带参数 schema）——长期常驻；
 *  2) `tools_help` —— 一次批量查 1~8 个工具的**可照抄用法**（参数名/必填/枚举/示例），
 *     而不是再返回一遍 JSON Schema，避免模型"翻译 schema"翻车。
 *
 * 为什么不给参数 schema：实测（AI剪辑 同款结论）模型看到完整 schema 也常常
 * 写错数组/对象；给"照抄模板"更稳，且常驻体积从 ~12k token 降到 ~2k。
 *
 * 注册参数：无。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Cordis 函数插件名。 */
export const name = 'tool-compact';
/** 依赖的宿主服务。 */
export const inject = ['tools', 'systemPrompt'];
/** 一行摘要的长度上限（按句号截断，不切半句）。 */
const SUMMARY_LIMIT = 60;
/** 单次 tools_help 最多查几个工具（保持一次回复不膨胀）。 */
const HELP_BATCH_MAX = 8;
/** 取第一句完整的话（没有句号就在上限处截断）。 */
function first_sentence(text, limit = SUMMARY_LIMIT) {
    const flat = (text ?? '').replace(/\s+/g, ' ').trim();
    if (flat === '')
        return '';
    for (let index = 0; index < flat.length && index < limit; index += 1) {
        const char = flat[index];
        if (char === '。' || char === '；' || (char === '.' && (index + 1 >= flat.length || flat[index + 1] === ' '))) {
            return flat.slice(0, index + 1);
        }
    }
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
/** 把 schema 里的参数规整成条目列表。 */
function parameters_of(schema) {
    const source = (schema ?? {});
    const required = new Set(Array.isArray(source.required) ? source.required.map(String) : []);
    return Object.entries(source.properties ?? {}).map(([name, rule]) => ({
        name,
        rule: (rule ?? {}),
        required: required.has(name),
    }));
}
/** 值占位符：让"该写什么形状"一眼可见。 */
function placeholder(rule) {
    const kind = String(rule.type ?? 'string');
    if (Array.isArray(rule.enum) && rule.enum.length > 0)
        return `<${rule.enum.map(String).join('|')}>`;
    if (kind === 'integer' || kind === 'number')
        return '<数字>';
    if (kind === 'boolean')
        return '<是|否>';
    if (kind === 'array') {
        const items = (rule.items ?? {});
        return items.type === 'object' ? '<块>' : '<一项,一项>';
    }
    if (kind === 'object')
        return '<对象>';
    return '<值>';
}
/** 生成一条"可照抄"的用法记录。 */
function usage_note(name, schema) {
    const params = parameters_of(schema.parameters);
    const required = params.filter(item => item.required);
    const optional = params.filter(item => !item.required);
    const lines = [`### ${name}`, `用途：${first_sentence(schema.description, 200)}`];
    if (params.length === 0) {
        lines.push('参数：无');
    }
    else {
        lines.push('必填：' + (required.length === 0
            ? '无'
            : required.map(item => `${item.name}=${placeholder(item.rule)}`).join('，')));
        if (optional.length > 0) {
            lines.push('可选：' + optional.map(item => `${item.name}=${placeholder(item.rule)}`).join('，'));
        }
        // 示例：把所有必填项按"照抄改值"的形态拼出来（数组给一个示例元素）
        const example = required.map(item => `${item.name}=${placeholder(item.rule)}`).join('，');
        lines.push(`示例：${name}(${example})`);
    }
    return lines.join('\n');
}
/** 插件入口。 */
export function apply(ctx) {
    /** 最近一次组装看到的完整工具表。 */
    const table = new Map();
    ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const resolved = await next();
        table.clear();
        for (const tool of resolved.tools)
            table.set(tool.name, tool);
        return {
            ...resolved,
            tools: resolved.tools.map(tool => tool.name === 'tools_help'
                ? tool
                : ({
                    name: tool.name,
                    description: `${first_sentence(tool.description)}（参数用 tools_help 查）`,
                    parameters: { type: 'object', properties: {} },
                })),
        };
    }));
    ctx.tools.register(defineTool({
        name: 'tools_help',
        description: [
            '批量查工具的用法与参数（1~8 个，逗号分隔），返回可直接照抄的「参数名=值」格式。',
            '调用不熟悉的工具前先查；不传则列出全部工具名与一句话说明。',
        ].join('\n'),
        parameters: {
            tools: { type: 'string', description: '工具名，逗号分隔，最多 8 个；不传=列出全部' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args) {
            const raw = args.tools ?? args.names ?? args['工具'] ?? args['工具名'] ?? '';
            const names = (Array.isArray(raw) ? raw.join(',') : String(raw))
                .split(/[,，\s]+/)
                .map(item => item.trim())
                .filter(item => item !== '');
            if (names.length === 0) {
                if (table.size === 0)
                    return { ok: false, text: '工具表还没组装过，稍后再试。' };
                const lines = [...table.entries()]
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([toolName, tool]) => `- ${toolName}: ${first_sentence(tool.description)}`);
                return { ok: true, text: `共 ${table.size} 个工具：\n${lines.join('\n')}` };
            }
            if (names.length > HELP_BATCH_MAX) {
                return { ok: false, text: `一次最多查 ${HELP_BATCH_MAX} 个，请拆成多次；本次给了 ${names.length} 个。` };
            }
            const blocks = [];
            const missing = [];
            for (const name of names) {
                const tool = table.get(name);
                if (tool === undefined) {
                    missing.push(name);
                    continue;
                }
                blocks.push(usage_note(tool.name, tool));
            }
            if (missing.length > 0)
                blocks.push(`未找到：${missing.join(', ')}（可用 tools_help 不传参数看全部名字）`);
            return { ok: true, text: blocks.join('\n\n') };
        },
    }));
}
//# sourceMappingURL=index.js.map