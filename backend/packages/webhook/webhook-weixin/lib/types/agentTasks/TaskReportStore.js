import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, realpathSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
export class TaskReportStore {
    root;
    constructor(root){
        this.root = root;
    }
    get_path(id, kind = 'report') {
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error('非法任务产物标识');
        const dir = join(resolve(this.root), 'runtime', 'agentTasks', 'reports');
        mkdirSync(dir, {
            recursive: true
        });
        if (!realpathSync(dir).startsWith(realpathSync(this.root) + sep)) throw Error('任务产物目录越界');
        return join(dir, `${kind === 'report' ? '任务报告' : '执行总结'}-${id}.md`);
    }
    save_report(id, text, kind = 'report') {
        if (typeof text !== 'string' || !text.trim() || text.length > 2000000) throw Error('报告正文必须为1至二百万字符');
        const file = this.get_path(id, kind), temp = `${file}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temp, text, {
                encoding: 'utf8',
                flag: 'wx'
            });
            renameSync(temp, file);
        } finally{
            if (existsSync(temp)) unlinkSync(temp);
        }
        return {
            path: file,
            characters: text.length
        };
    }
    persist_result(task) {
        const summary = this.save_report(task.id, task.result || '没有取得执行总结。', 'summary');
        const report = this.get_path(task.id);
        const has = existsSync(report) && lstatSync(report).isFile() && !lstatSync(report).isSymbolicLink();
        return {
            reportPath: has ? report : summary.path,
            summaryPath: summary.path,
            reportSaved: has
        };
    }
    report_info(id) {
        const path = this.get_path(id);
        if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return {
            path,
            exists: false,
            characters: 0
        };
        const text = readFileSync(path, 'utf8');
        return {
            path,
            exists: true,
            characters: text.length
        };
    }
    read_report(id, offset = 0, limit = 6000) {
        const info = this.report_info(id);
        if (!info.exists) return {
            ...info,
            offset: 0,
            nextOffset: null,
            text: ''
        };
        if (!Number.isInteger(offset) || offset < 0) throw Error('报告偏移必须为非负整数');
        if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw Error('报告读取长度必须为1至20000字符');
        const text = readFileSync(info.path, 'utf8');
        const end = Math.min(text.length, offset + limit);
        return {
            ...info,
            offset,
            nextOffset: end < text.length ? end : null,
            text: text.slice(offset, end)
        };
    }
}
