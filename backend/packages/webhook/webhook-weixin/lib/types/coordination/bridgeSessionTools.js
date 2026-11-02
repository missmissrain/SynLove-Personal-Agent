import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { probe } from '../diagnostics/probe.js';
const MAX_CHARS = 6_000;
function codex_home() {
    return process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.codex');
}
function opencode_data_dir() {
    return process.env.OPENCODE_DATA_DIR ?? join(process.env.USERPROFILE ?? homedir(), '.local', 'share', 'opencode');
}
export function list_codex_sessions(limit = 8) {
    const state_path = join(codex_home(), 'state_5.sqlite');
    if (!existsSync(state_path)) return [];
    let db;
    try {
        db = new DatabaseSync(state_path, {
            readOnly: true
        });
        const rows = db.prepare('SELECT id, rollout_path, cwd, title, updated_at FROM threads ' + 'WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?').all(limit);
        return rows.map((row)=>{
            const rollout = String(row.rollout_path ?? '');
            const last_user = read_codex_messages(rollout, 12).filter((item)=>item.role === 'user').at(-1);
            const title = last_user?.text ?? String(row.title ?? '未命名任务');
            return {
                tool: 'codex',
                id: String(row.id),
                title: title.slice(0, 80),
                workspace: normalize_path(String(row.cwd ?? '')),
                status: codex_lifecycle(rollout),
                updated_at: Number(row.updated_at ?? 0),
                rollout_path: rollout
            };
        });
    } catch (error) {
        probe('bridge-sessions', 'codex_db_failed', {
            error: String(error)
        });
        return [];
    } finally{
        try {
            db?.close();
        } catch  {}
    }
}
function codex_lifecycle(rollout_path) {
    if (rollout_path === '' || !existsSync(rollout_path)) return '记录缺失';
    const patterns = [
        [
            '"type":"task_complete"',
            '已完成'
        ],
        [
            '"type":"turn_aborted"',
            '已中止'
        ],
        [
            '"type":"task_started"',
            '运行中'
        ]
    ];
    try {
        const size = statSync(rollout_path).size;
        const data = readFileSync(rollout_path);
        const tail = data.subarray(Math.max(0, size - 512 * 1024)).toString('utf8');
        const lines = tail.split('\n');
        for(let index = lines.length - 1; index >= 0; index -= 1){
            const line = lines[index];
            for (const [marker, status] of patterns){
                if (line.includes(marker)) return status;
            }
        }
    } catch  {}
    return '未知';
}
export function read_codex_messages(rollout_path, limit = 12) {
    if (rollout_path === '' || !existsSync(rollout_path)) return [];
    const out = [];
    try {
        const size = statSync(rollout_path).size;
        const data = readFileSync(rollout_path);
        const text = data.subarray(Math.max(0, size - 4 * 1024 * 1024)).toString('utf8');
        for (const line of text.split('\n')){
            if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.type !== 'response_item' || parsed.payload?.type !== 'message') continue;
                const role = parsed.payload.role;
                if (role !== 'user' && role !== 'assistant') continue;
                const parts = (parsed.payload.content ?? []).map((part)=>part.text ?? part.output_text ?? '').filter((item)=>item.trim() !== '');
                const body = parts.join('\n').trim();
                if (body === '') continue;
                const clean = role === 'user' ? clean_user_message(body) : body;
                if (clean === '') continue;
                out.push({
                    role,
                    text: clean,
                    ...parsed.timestamp === undefined ? {} : {
                        at: parsed.timestamp
                    }
                });
            } catch  {}
        }
    } catch (error) {
        probe('bridge-sessions', 'codex_rollout_failed', {
            error: String(error)
        });
    }
    return out.slice(-limit);
}
function normalize_path(path) {
    return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}
function clean_user_message(message) {
    const marker = '## My request for Codex:';
    let text = message;
    if (text.includes(marker)) text = text.slice(text.indexOf(marker) + marker.length);
    text = text.trim();
    if (text.startsWith('<environment_context>') || text.startsWith('<permissions instructions>')) return '';
    return text;
}
export function list_opencode_sessions(limit = 8) {
    const db_path = join(opencode_data_dir(), 'opencode.db');
    if (!existsSync(db_path)) return [];
    let db;
    try {
        db = new DatabaseSync(db_path, {
            readOnly: true
        });
        const rows = db.prepare('SELECT id, directory, title, time_created, time_updated FROM session ' + 'WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?').all(limit);
        return rows.map((row)=>({
                tool: 'opencode',
                id: String(row.id),
                title: String(row.title ?? '').trim() || '(无标题)',
                workspace: String(row.directory ?? ''),
                status: 'opencode 会话',
                updated_at: Number(row.time_updated ?? 0)
            }));
    } catch (error) {
        probe('bridge-sessions', 'opencode_db_failed', {
            error: String(error)
        });
        return [];
    } finally{
        try {
            db?.close();
        } catch  {}
    }
}
export function read_opencode_messages(session_id, limit = 12) {
    const db_path = join(opencode_data_dir(), 'opencode.db');
    if (session_id === '' || !existsSync(db_path)) return [];
    let db;
    const out = [];
    try {
        db = new DatabaseSync(db_path, {
            readOnly: true
        });
        const scan = Math.min(400, Math.max(limit * 8, 40));
        const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT ?').all(session_id, scan);
        for (const message of messages.reverse()){
            let role = '';
            try {
                const parsed = JSON.parse(message.data);
                role = String(parsed.role ?? '');
            } catch  {}
            if (role !== 'user' && role !== 'assistant') continue;
            const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC').all(message.id);
            const texts = [];
            for (const part of parts){
                try {
                    const parsed = JSON.parse(part.data);
                    if (parsed.type === 'text' && typeof parsed.text === 'string' && parsed.text.trim() !== '') {
                        texts.push(parsed.text.trim());
                    }
                } catch  {}
            }
            if (texts.length === 0) continue;
            out.push({
                role,
                text: texts.join('\n')
            });
        }
    } catch (error) {
        probe('bridge-sessions', 'opencode_messages_failed', {
            error: String(error)
        });
        return [];
    } finally{
        try {
            db?.close();
        } catch  {}
    }
    return out.slice(-limit);
}
function ago(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '时间未知';
    const minutes = Math.round((Date.now() - ms) / 60_000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} 小时前`;
    return `${Math.round(hours / 24)} 天前`;
}
function clip(text) {
    return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n…（已截断）`;
}
function render_sessions(sessions, tool) {
    const mine = sessions.filter((item)=>item.tool === tool);
    if (mine.length === 0) return [
        `【${tool} 会话】没有找到会话记录。`
    ];
    const lines = [
        `【${tool} 会话】最近 ${mine.length} 个：`
    ];
    for (const item of mine){
        const short = item.id.slice(0, 8);
        const name = item.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
        lines.push(`- ${short}…（${item.id}）`);
        lines.push(`    任务：${item.title}`);
        lines.push(`    项目：${name || item.workspace}　状态：${item.status}　更新：${ago(item.updated_at)}`);
    }
    return lines;
}
export function register_bridge_session_tools(agent_ctx) {
    agent_ctx.tools.register(defineTool({
        name: 'bridge_sessions',
        description: [
            'codex/opencode 会话记录：列出本机 Codex 与 opencode 的会话（带名字与项目），',
            '或读某个会话的聊天记录。用于**远程指挥**这些会话。',
            '',
            '两种用法：',
            '- 不填 session_id：列出两个工具的最近会话（含会话 id、任务名、项目、状态、更新时间）；',
            '- 填 session_id：读那个会话最近的聊天记录（用户说了什么、助手回了什么）。',
            '',
            '什么时候该用：',
            '- 用户问"有哪些会话/上次那个任务叫什么/那个项目做到哪了"；',
            '- 用户想继续某个任务，但没说清是哪个会话——先列出来让他确认；',
            '- 用户问"你刚才在那个会话里说了什么/结果是什么"。',
            '',
            '拿到 session_id 之后，可以用 `codex` / `opencode` 工具续那个会话（不要凭印象编造会话 id）。',
            '什么时候不该用：用户只是闲聊、或明确在说微信这边的对话时不要调用。'
        ].join('\n'),
        parameters: {
            tool: {
                type: 'string',
                description: "查哪个工具：codex | opencode | both（默认 both）。"
            },
            session_id: {
                type: 'string',
                description: '要读聊天记录的会话 id（列表里那一长串）；不填就只列会话。'
            },
            limit: {
                type: 'number',
                description: '最多几条，默认 8（列会话）/ 12（读记录）。'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: {
                        type: 'boolean',
                        required: true
                    },
                    text: {
                        type: 'string',
                        required: true
                    }
                }
            },
            render: (_args, value)=>[
                    {
                        type: 'text',
                        text: String(value.text ?? '')
                    }
                ]
        },
        async execute (args) {
            const tool = (args.tool ?? 'both').trim().toLowerCase();
            const session_id = typeof args.session_id === 'string' ? args.session_id.trim() : '';
            const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.min(30, Math.floor(Number(args.limit))) : session_id === '' ? 8 : 12;
            if (session_id !== '') {
                const codex_sessions = list_codex_sessions(30);
                const codex_hit = codex_sessions.find((item)=>item.id === session_id || item.id.startsWith(session_id));
                if (codex_hit !== undefined && codex_hit.rollout_path !== undefined) {
                    const messages = read_codex_messages(codex_hit.rollout_path, limit);
                    return {
                        ok: true,
                        text: clip(render_messages('codex', codex_hit, messages))
                    };
                }
                const opencode_sessions = list_opencode_sessions(30);
                const opencode_hit = opencode_sessions.find((item)=>item.id === session_id || item.id.startsWith(session_id));
                if (opencode_hit !== undefined) {
                    const messages = read_opencode_messages(opencode_hit.id, limit);
                    return {
                        ok: true,
                        text: clip(render_messages('opencode', opencode_hit, messages))
                    };
                }
                return {
                    ok: true,
                    text: `没有找到会话"${session_id}"。可以不带 session_id 先列一遍（会话 id 很长，` + '列表里给的是完整 id，请整串照抄）。'
                };
            }
            const sessions = [
                ...tool === 'opencode' ? [] : list_codex_sessions(limit),
                ...tool === 'codex' ? [] : list_opencode_sessions(limit)
            ];
            if (sessions.length === 0) {
                return {
                    ok: true,
                    text: '本机没有找到 Codex / opencode 的会话记录。'
                };
            }
            const lines = [];
            if (tool !== 'opencode') lines.push(...render_sessions(sessions, 'codex'));
            if (tool !== 'codex') {
                if (lines.length > 0) lines.push('');
                lines.push(...render_sessions(sessions, 'opencode'));
            }
            lines.push('', '（要看某个会话的聊天记录：把它的会话 id 传给本工具的 session_id。）');
            return {
                ok: true,
                text: clip(lines.join('\n'))
            };
        }
    }));
}
function render_messages(tool, session, messages) {
    const name = session.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? session.workspace;
    const lines = [
        `【${tool} 会话 ${session.id}】`,
        `任务：${session.title}`,
        `项目：${name}　状态：${session.status}　更新：${ago(session.updated_at)}`,
        ''
    ];
    if (messages.length === 0) {
        lines.push('（这个会话里没有可读的对话内容）');
        return lines.join('\n');
    }
    for (const message of messages){
        lines.push(`[${message.role === 'user' ? '用户' : '助手'}] ${message.text}`);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}
