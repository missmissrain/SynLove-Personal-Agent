import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'tool-opencode';
export const inject = [
    'tools'
];
const RUN_TIMEOUT_MS = 900_000;
const MAX_OUTPUT_CHARS = 8_000;
const ACTIONS = [
    'list_sessions',
    'run',
    'export',
    'stats'
];
const DEFAULT_OPENCODE_BIN = process.env.OPENCODE_BIN?.trim() || 'opencode';
const DEFAULT_WORKSPACE = process.env.DSH_OPENCODE_WORKSPACE?.trim() || process.cwd();
const DEFAULT_SERVER_URL = 'http://127.0.0.1:4096';
function resolve_bin() {
    const configured = process.env.OPENCODE_BIN;
    if (configured !== undefined && configured.trim() && existsSync(configured.trim())) return configured.trim();
    if (existsSync(DEFAULT_OPENCODE_BIN)) return DEFAULT_OPENCODE_BIN;
    return 'opencode';
}
function resolve_server_url() {
    const configured = process.env.OPENCODE_SERVER_URL;
    if (configured !== undefined && configured.trim()) return configured.trim();
    return DEFAULT_SERVER_URL;
}
function strip_ansi(text) {
    return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
}
function run_opencode(args, cwd, signal) {
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
                text: 'ERROR: ' + (error.message || 'opencode 启动失败')
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
                    text: text + '\n调用已取消；远程 server 中已派出的任务仍需另行确认停止。'
                });
                return;
            }
            if (timed_out) {
                resolve({
                    ok: false,
                    text: (text ? text + '\n' : '') + `ERROR: opencode 超过 ${Math.round(RUN_TIMEOUT_MS / 1000)} 秒未返回，已终止本次调用。` + '这说明任务本身很重。不要改参数重试、不要自己写脚本顶替，' + '直接把"这个任务耗时超过预期、需要更长等待"告诉用户。'
                });
                return;
            }
            if (code !== 0) {
                resolve({
                    ok: false,
                    text: (text ? text + '\n' : '') + `ERROR: opencode 退出码 ${code}。`
                });
                return;
            }
            resolve({
                ok: true,
                text: text || '(opencode 无输出)'
            });
        });
    });
}
function session_listed(list_text, session) {
    const escaped = session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(list_text);
}
function ask_text(missing) {
    return [
        `需要你先确认${missing}，我不能替你猜。`,
        '请告诉我要用哪个**工作区目录**和哪个**会话 id**；',
        '如果不知道有哪些，我可以先执行 action="list_sessions" 列出会话，或你直接告诉我项目目录我去看。'
    ].join('');
}
const SHELL_TOOLS = new Set([
    'pwsh',
    'bash'
]);
function lacks_fork(command) {
    if (!/opencode/i.test(command)) return false;
    if (/--fork/.test(command)) return false;
    return /(^|\s)(-s|--session)(\s|=)/.test(command);
}
export function apply(ctx) {
    ctx.on('tools/pre-execute', (exec, next)=>{
        if (SHELL_TOOLS.has(exec.name)) {
            const args = exec.arguments;
            const command = typeof args?.command === 'string' ? args.command : '';
            if (lacks_fork(command)) {
                return Promise.resolve({
                    kind: 'deny',
                    reason: '不要用 shell 调 opencode（脱离 server 会无限阻塞）。请直接调用 opencode 工具' + '（action=run，session=<会话id>，prompt=<内容>）；' + '若必须用 shell，须带 --attach 与 --fork：' + 'opencode run --auto --attach ' + resolve_server_url() + ' --fork -s <会话id> "<内容>"。'
                });
            }
        }
        return next();
    });
    ctx.tools.register(defineTool({
        name: 'opencode',
        description: [
            '把任务交给本机的 opencode —— 一个独立的通用编程/自动化 agent（和你一样会自己读写文件、执行命令、查资料、写代码、跑测试、调试，直到把任务做完）。',
            '你不知道怎么做的复杂任务，可以整包交给它；它会在指定工作区里自主完成，并把过程与结果返回给你。',
            '',
            '能力举例：写/改代码、创建项目与脚本、批量改文件、运行并调试命令、安装依赖、跑测试、修构建错误、整理目录、抓取/处理数据等。',
            '',
            '动作：',
            '- run：执行任务。省略 session = 新开一个会话跑这个任务（推荐，除非用户点名要接着某个会话）；给了 session 就在该会话上 fork 继续。',
            '- list_sessions：列出已有会话（不确定用哪个会话时先列出来给用户挑，不要猜 id）。',
            '- export：导出某个会话内容。stats：查看用量。',
            '',
            '使用要求：',
            `1) 默认工作区：${DEFAULT_WORKSPACE}`,
            '   （部署时用 DSH_OPENCODE_WORKSPACE 指定；脚本/文档/数据都放这里）。',
            '   只有用户明确指定别的目录时，才改用他给的那个绝对路径；不要用 "." 或相对路径。',
            '2) prompt 要写成一个自包含的完整任务：目标、要求的产物、约束条件一次说清（它的模型看不到你和用户的对话）。',
            '3) 这个调用会真的执行，可能跑几十秒到十几分钟，请耐心等返回。',
            '4) 返回后先判断"成功还是失败"，然后给结论收尾；同一个任务不要反复调用，失败最多改一次就如实汇报。'
        ].join('\n'),
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '要执行的动作：run（交任务） | list_sessions（列会话） | export（导出会话） | stats（看用量）'
            },
            workspace: {
                type: 'string',
                description: `opencode 的工作区目录（绝对路径）。默认：${DEFAULT_WORKSPACE}`
            },
            session: {
                type: 'string',
                description: '会话 id。run 时省略 = 新建会话（推荐）；给了就在该会话上 fork 继续（export 必填）'
            },
            prompt: {
                type: 'string',
                description: 'run 时发给 opencode 的完整任务描述：目标、要产出什么、有什么约束。要自包含，它看不到你和用户的对话。'
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
            const workspace = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined;
            const session = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : undefined;
            const raw = typeof args.prompt === 'string' ? args.prompt : '';
            const prompt = raw && String(exec.agent?.id ?? '').startsWith('task-') ? `[SynLoveTask:${exec.agent.id}]\n${raw}` : raw;
            if (action === 'list_sessions') {
                return run_opencode([
                    'session',
                    'list'
                ], workspace, exec.signal);
            }
            if (action === 'stats') {
                return run_opencode([
                    'stats'
                ], workspace, exec.signal);
            }
            if (action === 'export') {
                if (session === undefined) return {
                    ok: false,
                    text: ask_text('会话 id')
                };
                return run_opencode([
                    'export',
                    session
                ], workspace, exec.signal);
            }
            if (workspace === undefined) return {
                ok: false,
                text: ask_text('工作区目录')
            };
            if (!prompt.trim()) return {
                ok: false,
                text: 'run 需要一个非空的 prompt（要发给 opencode 的内容）。'
            };
            if (session !== undefined) {
                const listed = await run_opencode([
                    'session',
                    'list'
                ], workspace, exec.signal);
                if (listed.ok && !session_listed(listed.text, session)) {
                    return {
                        ok: false,
                        text: `会话 "${session}" 在这个工作区里不存在（opencode 的会话**按工作区隔离**，` + '换个 --dir 就找不到同一个会话）。\n\n' + '该工作区已有的会话（id 请**整串照抄**，不要凭记忆写、不要加字符）：\n' + listed.text.slice(0, MAX_OUTPUT_CHARS) + '\n要接着某个会话就照抄它的 id；要新开一个就省略 session 参数。'
                    };
                }
            }
            const attach = [
                '--attach',
                resolve_server_url()
            ];
            const dir_args = workspace === undefined ? [] : [
                '--dir',
                workspace
            ];
            const run_args = session === undefined ? [
                'run',
                '--auto',
                ...attach,
                ...dir_args,
                prompt
            ] : [
                'run',
                '--auto',
                ...attach,
                ...dir_args,
                '--fork',
                '-s',
                session,
                prompt
            ];
            return run_opencode(run_args, workspace, exec.signal);
        }
    }));
}
