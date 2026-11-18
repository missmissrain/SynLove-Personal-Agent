/**
 * 记事簿查询工具：主人问“最近做了什么”或聊到查过的话题时，先查这里。
 * 参数：agent_ctx 为 agent 作用域，notebook 默认取共享实例。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MemoryToolRegistry } from '../memory/MemoryToolRegistry.js';
import { NotebookStore, shared_notebook } from './NotebookStore.js';
const MAX_CHARS = 4000;
/** 把时间写成“10-18 19:20”。 */
function stamp(ts) {
    const date = new Date(ts);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hour}:${minute}`;
}
/** 把条目写成可读的一段。 */
function render_entry(entry, now) {
    const age = NotebookStore.age_hours(entry, now);
    const fresh = NotebookStore.fresh(entry, now);
    const freshness = fresh ? `还有效，${age} 小时前` : `已过时效，${age} 小时前`;
    const sources = entry.sources.length === 0 ? '' : `\n来源：${entry.sources.join(' ')}`;
    return `[${stamp(entry.created_at)}] ${entry.title}（${freshness}）\n${entry.summary}${sources}`;
}
/** 注册记事簿查询工具。 */
export function register_notebook_tools(agent_ctx, notebook) {
    const store = notebook ?? shared_notebook();
    MemoryToolRegistry.register_tools(agent_ctx, 'notebook', (register)=>{
        register(defineTool({
            name: 'notebook_query',
            description: [
                '查欣爱自己的记事簿：她主动查过的机票、显卡、部署、漫剧等结果。',
                '',
                '什么时候用：',
                '- 主人问“最近做了什么”“之前查的机票呢”“有没有新消息”，不填参数，看最近条目；',
                '- 聊到机票、显卡、本地部署、AI 漫剧这些她可能查过的话题，用 query 搜一下；',
                '- 条目还在时效内就直接引用结果，不要重新上网查；已过时效就说明是几天前的，再决定要不要重查。',
                '',
                '怎么用：',
                '- 不填 → 最近条目；',
                '- query → 关键词搜索；',
                '- id → 看某一条的完整摘要和来源。',
                '',
                '主人没问就不要主动报流水账；他问细节时再展开。'
            ].join('\n'),
            parameters: {
                query: { type: 'string', description: '关键词，例如 机票、显卡、MiniMax。' },
                id: { type: 'string', description: '条目标识；给了就返回这一条。' },
                limit: { type: 'number', description: '最多几条，默认 6。' }
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        text: { type: 'string', required: true }
                    }
                },
                render: (_args, value)=>[
                        { type: 'text', text: String(value.text ?? '') }
                    ]
            },
            async execute(args) {
                const now = Date.now();
                const limit = Math.max(1, Math.min(20, Number(args.limit ?? 6)));
                if (typeof args.id === 'string' && args.id.trim() !== '') {
                    const entry = store.get(args.id.trim());
                    return entry === undefined ? { ok: false, text: '记事簿里没有这一条。' } : { ok: true, text: render_entry(entry, now) };
                }
                const list = typeof args.query === 'string' && args.query.trim() !== '' ? store.search(args.query, now, limit) : store.recent(14, now, limit);
                if (list.length === 0) return { ok: true, text: '记事簿里最近没有相关记录。' };
                const text = list.map((entry)=>render_entry(entry, now)).join('\n\n');
                return { ok: true, text: text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS) + '\n…（已截断）' };
            }
        }));
    });
}
