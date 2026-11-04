/**
 * 执行进度缓存：每个后台任务一份只追加的 JSONL 文件，记录执行内核每一次助手回复。
 * 参数 root 为项目根目录；缓存固定落在 runtime/agentTasks/progress，不接受模型传入的路径。
 * 任务结束时由 TaskRuntime 整份销毁，不留历史。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export class TaskProgressCache {
    root;
    constructor(root){
        this.root = root;
    }
    dir() {
        return join(this.root, 'runtime', 'agentTasks', 'progress');
    }
    path(id) {
        if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('任务ID不能用于进度缓存');
        return join(this.dir(), `${id}.jsonl`);
    }
    append(id, text, at) {
        const body = String(text ?? '').trim();
        if (!body) return;
        const file = this.path(id);
        mkdirSync(this.dir(), {
            recursive: true
        });
        appendFileSync(file, JSON.stringify({
            at,
            text: body.slice(0, 8000)
        }) + '\n', 'utf8');
    }
    count(id) {
        const file = this.path(id);
        if (!existsSync(file)) return 0;
        return readFileSync(file, 'utf8').split('\n').filter((line)=>line.trim()).length;
    }
    read(id, limit = 30) {
        const file = this.path(id);
        if (!existsSync(file)) return [];
        const rows = [];
        for (const line of readFileSync(file, 'utf8').split('\n')){
            if (!line.trim()) continue;
            try {
                rows.push(JSON.parse(line));
            } catch  {}
        }
        return rows.slice(-Math.max(1, Math.min(200, limit)));
    }
    clear(id) {
        try {
            rmSync(this.path(id), {
                force: true
            });
        } catch  {}
        try {
            const dir = this.dir();
            if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, {
                recursive: true,
                force: true
            });
        } catch  {}
    }
}
