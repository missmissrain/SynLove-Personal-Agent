import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, realpathSync, lstatSync } from 'node:fs';
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
}
