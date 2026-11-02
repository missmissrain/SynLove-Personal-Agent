import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'tool-codex';
export const inject = [
    'tools'
];
const RUN_TIMEOUT_MS = 900_000;
const MAX_OUTPUT_CHARS = 8_000;
const ACTIONS = [
    'list_sessions',
    'run',
    'resume'
];
const DEFAULT_WORKSPACE = process.env.DSH_CODEX_WORKSPACE?.trim() || process.cwd();
const DEFAULT_CODEX_BIN = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin', 'codex.exe');
function resolve_bin() {
    const configured = process.env.CODEX_BIN;
    if (configured !== undefined && configured.trim() && existsSync(configured.trim())) return configured.trim();
    if (existsSync(DEFAULT_CODEX_BIN)) return DEFAULT_CODEX_BIN;
    return 'codex';
}
function strip_ansi(text) {
    return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
}
function run_codex(args, cwd, signal) {
    return new Promise((resolve)=>{
        if (signal?.aborted) {
            resolve({
                ok: false,
                text: '本次调用已取消，未启动进程。'
            });
            return;
        }
        const bin = resolve_bin();
        const command = bin.toLowerCase().endsWith('.exe') ? bin : 'cmd.exe';
        const command_args = command === 'cmd.exe' ? [
            '/c',
            bin,
            ...args
        ] : args;
        const child = spawn(command, command_args, {
            cwd,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe'
            ]
        });
        const chunks = [];
        let bytes = 0;
        let timed_out = false;
        const abort = ()=>{
            if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', [
                '/PID',
                String(child.pid),
                '/T',
                '/F'
            ], {
                windowsHide: true,
                stdio: 'ignore'
            }).on('error', ()=>child.kill());
            else child.kill();
        };
        signal?.addEventListener('abort', abort, {
            once: true
        });
        const timer = setTimeout(()=>{
            timed_out = true;
            abort();
        }, RUN_TIMEOUT_MS);
        const collect = (data)=>{
            bytes += data.length;
            if (bytes <= 4 * 1024 * 1024) chunks.push(data);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', (error)=>{
            signal?.removeEventListener('abort', abort);
            clearTimeout(timer);
            resolve({
                ok: false,
                text: 'ERROR: ' + (error.message || 'codex 启动失败')
            });
        });
        child.on('close', (code)=>{
            signal?.removeEventListener('abort', abort);
            clearTimeout(timer);
            const combined = strip_ansi(Buffer.concat(chunks).toString('utf8')).trim();
            const text = combined.length > MAX_OUTPUT_CHARS ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n…（输出过长，已截断，共 ${combined.length} 字符）` : combined;
            if (signal?.aborted) {
                resolve({
                    ok: false,
                    text: text + '\n本次调用已取消；已完成的文件或外部操作不会回滚。'
                });
                return;
            }
            if (timed_out) {
                resolve({
                    ok: false,
                    text: (text ? text + '\n' : '') + `ERROR: Codex 超过 ${Math.round(RUN_TIMEOUT_MS / 1000)} 秒未返回，已终止。` + '任务本身很重；不要原样重试，把"耗时超预期"如实告诉用户。'
                });
                return;
            }
            if (code !== 0) {
                resolve({
                    ok: false,
                    text: (text ? text + '\n' : '') + `ERROR: Codex 退出码 ${code}。`
                });
                return;
            }
            resolve({
                ok: true,
                text: text || '(codex 无输出)'
            });
        });
    });
}
function list_sessions(limit = 10) {
    const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    if (!existsSync(root)) return {
        ok: true,
        text: '(没有找到 Codex 会话目录)'
    };
    const files = [];
    const walk = (dir, depth = 0)=>{
        if (depth > 5) return;
        for (const entry of readdirSync(dir, {
            withFileTypes: true
        })){
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
                const stat = statSync(full);
                files.push({
                    path: full,
                    mtime: stat.mtimeMs,
                    size: stat.size
                });
            }
        }
    };
    try {
        walk(root);
    } catch (error) {
        return {
            ok: false,
            text: 'ERROR: 读取会话目录失败：' + String(error)
        };
    }
    files.sort((a, b)=>b.mtime - a.mtime);
    const lines = files.slice(0, limit).map((item)=>{
        const base = item.path.split(/[\\/]/).pop() ?? '';
        const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        const when = new Date(item.mtime).toLocaleString('zh-CN');
        return `- ${match?.[1] ?? base}   ${when}   ${Math.round(item.size / 1024)}KB`;
    });
    return {
        ok: true,
        text: lines.length > 0 ? lines.join('\n') : '(没有会话记录)'
    };
}
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'codex',
        description: [
            '把任务交给本机的 Codex —— 一个独立的通用编程/自动化 agent（OpenAI 官方 CLI，稳定可靠）。',
            '它会自己读写文件、执行命令、查资料、写代码、跑测试、调试，直到把任务做完，并把过程与结果返回给你。',
            '不知道怎么做、或需要多步动手的复杂任务，可以整包交给它。',
            '',
            '能力举例：写/改代码、创建项目与脚本、批量改文件、运行并调试命令、安装依赖、跑测试、修构建错误、整理目录、数据分析等。',
            '',
            '动作：',
            '- run：执行任务。用新的 Codex 会话跑这个任务（推荐）。',
            '- resume：在已有会话上继续（session 给会话 id，或填 "last" 表示最近一个）。',
            '- list_sessions：列出最近的 Codex 会话（需要接着某个会话时先看这个，不要猜 id）。',
            '',
            '使用要求：',
            `1) 默认工作区：${DEFAULT_WORKSPACE}`,
            '   （部署时用 DSH_CODEX_WORKSPACE 指定；脚本/文档/数据都放这里）。只有用户明确指定别的目录时才改用他给的绝对路径。',
            '2) prompt 必须是自包含的完整任务：目标、要产出什么、约束条件一次说清（它看不到你和用户的对话）。',
            '3) 这个调用会真的执行，可能跑几十秒到十几分钟，请耐心等返回。',
            '4) 返回后先判断"成功还是失败"，然后给结论收尾；同一个任务不要反复调用，失败最多改一次就如实汇报。'
        ].join('\n'),
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '要执行的动作：run（交任务） | resume（续会话） | list_sessions（列会话）'
            },
            workspace: {
                type: 'string',
                description: 'Codex 的工作目录（绝对路径）。默认：' + DEFAULT_WORKSPACE
            },
            session: {
                type: 'string',
                description: 'resume 时的会话 id；也可以填 "last" 表示最近一个会话'
            },
            prompt: {
                type: 'string',
                description: 'run/resume 时发给 Codex 的完整任务描述：目标、要产出什么、有什么约束。要自包含。'
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
        async execute (args, exec) {
            const action = typeof args.action === 'string' ? args.action.trim() : '';
            if (!ACTIONS.includes(action)) {
                return {
                    ok: false,
                    text: `未知动作 "${action}"；可用：${ACTIONS.join(' | ')}`
                };
            }
            const workspace = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : DEFAULT_WORKSPACE;
            const session = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : undefined;
            const raw = typeof args.prompt === 'string' ? args.prompt : '';
            const prompt = raw && String(exec.agent?.id ?? '').startsWith('task-') ? `[SynLoveTask:${exec.agent.id}]\n${raw}` : raw;
            if (action === 'list_sessions') return list_sessions();
            const common = [
                '--skip-git-repo-check',
                '--dangerously-bypass-approvals-and-sandbox',
                '--color',
                'never'
            ];
            if (!prompt.trim()) return {
                ok: false,
                text: `${action} 需要一个非空的 prompt（任务内容）。`
            };
            if (action === 'resume') {
                if (session === undefined) {
                    return {
                        ok: false,
                        text: 'resume 需要 session（会话 id，或填 "last" 表示最近一个会话）；可先用 action=list_sessions 查看。'
                    };
                }
                const target = session === 'last' ? [
                    '--last'
                ] : [
                    session
                ];
                return run_codex([
                    'exec',
                    'resume',
                    ...target,
                    ...common,
                    prompt
                ], workspace, exec.signal);
            }
            return run_codex([
                'exec',
                '-C',
                workspace,
                ...common,
                prompt
            ], workspace, exec.signal);
        }
    }));
}
