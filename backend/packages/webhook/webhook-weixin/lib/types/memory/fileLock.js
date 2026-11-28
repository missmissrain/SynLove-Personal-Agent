import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { probe } from '../diagnostics/probe.js';
function pid_alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}
function sleep_ms(ms) {
    const shared = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(shared), 0, 0, ms);
}
export function with_file_lock(target_path, fn, options) {
    const timeout_ms = options?.timeout_ms ?? 10_000;
    const stale_ms = options?.stale_ms ?? 30_000;
    const retry_ms = options?.retry_ms ?? 20;
    const lock_path = `${target_path}.lock`;
    const deadline = Date.now() + timeout_ms;
    let handle;
    while(handle === undefined){
        try {
            handle = openSync(lock_path, 'wx');
            writeSync(handle, JSON.stringify({
                pid: process.pid,
                at: Date.now()
            }));
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let stale = false;
            try {
                const info = JSON.parse(readFileSync(lock_path, 'utf8'));
                const age = Date.now() - (info.at ?? 0);
                stale = age > stale_ms || !pid_alive(info.pid);
            } catch  {
                try {
                    stale = Date.now() - statSync(lock_path).mtimeMs > stale_ms;
                } catch  {
                    stale = true;
                }
            }
            if (stale) {
                probe('lock', 'stale_taken_over', {
                    lock_path
                });
                try {
                    unlinkSync(lock_path);
                } catch  {}
                continue;
            }
            if (Date.now() > deadline) {
                probe('lock', 'timeout', {
                    lock_path,
                    timeout_ms
                });
                throw new Error(`等锁超时（${timeout_ms}ms）：${lock_path}。为避免覆盖其它进程的合法写入，本次写入放弃。`);
            }
            sleep_ms(retry_ms);
        }
    }
    try {
        return fn();
    } finally{
        try {
            closeSync(handle);
        } catch  {}
        try {
            unlinkSync(lock_path);
        } catch  {}
    }
}
export function rename_with_retry(from, to, attempts = 5) {
    for(let attempt = 0;; attempt += 1){
        try {
            renameSync(from, to);
            return;
        } catch (error) {
            const code = error.code;
            if (attempt >= attempts - 1 || code !== 'EPERM' && code !== 'EBUSY') throw error;
            sleep_ms(15 * (attempt + 1));
        }
    }
}
