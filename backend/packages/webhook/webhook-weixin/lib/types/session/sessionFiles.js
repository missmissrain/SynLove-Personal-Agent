import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const LOG_FILE_PATTERN = /^session\.v\d+\.jsonl(\..+)?$/;
export function encode_segment(raw) {
    if (raw.length === 0) throw new Error('cannot encode an empty path segment');
    if (raw === '.') return '~002E';
    if (raw === '..') return '~002E~002E';
    let out = '';
    for(let index = 0; index < raw.length; index += 1){
        const code = raw.charCodeAt(index);
        const ch = String.fromCharCode(code);
        if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
        else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
    return out;
}
export function project_key(cwd) {
    if (cwd.length === 0) throw new Error('cannot encode an empty project path');
    let readable = '';
    let separator_run = false;
    for(let index = 0; index < cwd.length; index += 1){
        const code = cwd.charCodeAt(index);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
            if (!separator_run) readable += '-';
            separator_run = true;
        } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separator_run = false;
        } else {
            readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
            separator_run = false;
        }
    }
    const slug = readable.replace(/^-+/, '') || 'root';
    return `--${slug.slice(0, 251)}--`;
}
export function sessions_root(dsh_home) {
    const home = dsh_home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'sessions');
}
export function session_dir_path(root, cwd, id) {
    const project = cwd === undefined ? '_no-cwd' : project_key(cwd);
    return join(root, project, encode_segment(id));
}
export function clear_directory_contents(dir) {
    if (!existsSync(dir)) {
        mkdirSync(dir, {
            recursive: true
        });
        return {
            files: 0,
            bytes: 0,
            dir
        };
    }
    let files = 0;
    let bytes = 0;
    for (const name of readdirSync(dir)){
        const path = join(dir, name);
        try {
            const stat = statSync(path);
            if (stat.isFile()) {
                bytes += stat.size;
                files += 1;
            } else {
                bytes += directory_bytes(path);
                files += 1;
            }
            rmSync(path, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 100
            });
        } catch  {}
    }
    return {
        files,
        bytes,
        dir
    };
}
export function directory_bytes(dir) {
    let total = 0;
    let names;
    try {
        names = readdirSync(dir);
    } catch  {
        return 0;
    }
    for (const name of names){
        const path = join(dir, name);
        try {
            const stat = statSync(path);
            total += stat.isDirectory() ? directory_bytes(path) : stat.size;
        } catch  {}
    }
    return total;
}
export function session_log_stats(dir) {
    if (!existsSync(dir)) return undefined;
    let bytes = 0;
    let modified_at = 0;
    let files = 0;
    for (const name of readdirSync(dir)){
        if (!LOG_FILE_PATTERN.test(name)) continue;
        try {
            const stat = statSync(join(dir, name));
            bytes += stat.size;
            modified_at = Math.max(modified_at, stat.mtimeMs);
            files += 1;
        } catch  {}
    }
    return files === 0 ? undefined : {
        bytes,
        modified_at,
        files
    };
}
export function delete_session_artifacts(input) {
    let dir = '';
    try {
        dir = session_dir_path(input.root, input.cwd, input.id);
    } catch (error) {
        return {
            deleted: false,
            dir: '',
            reason: `路径推导失败：${String(error)}`
        };
    }
    if (!existsSync(dir)) return {
        deleted: false,
        dir,
        reason: '目录不存在（可能还没落盘）'
    };
    let entries;
    try {
        entries = readdirSync(dir);
    } catch (error) {
        return {
            deleted: false,
            dir,
            reason: `读目录失败：${String(error)}`
        };
    }
    if (!entries.some((name)=>LOG_FILE_PATTERN.test(name))) {
        return {
            deleted: false,
            dir,
            reason: '目录里没有会话日志文件，不像会话目录，已跳过'
        };
    }
    try {
        rmSync(dir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100
        });
        return {
            deleted: true,
            dir
        };
    } catch (error) {
        return {
            deleted: false,
            dir,
            reason: `删除失败：${String(error)}`
        };
    }
}
