import { execFileSync } from 'node:child_process';
import { probe } from '../diagnostics/probe.js';
export function gpu_memory() {
    try {
        const output = execFileSync('nvidia-smi', [
            '--query-gpu=memory.used,memory.total',
            '--format=csv,noheader,nounits'
        ], {
            encoding: 'utf8',
            timeout: 15_000,
            windowsHide: true
        });
        const first = output.trim().split('\n')[0] ?? '';
        const parts = first.split(',').map((item)=>Number(item.trim()));
        const used = parts[0];
        const total = parts[1];
        if (used === undefined || total === undefined) return undefined;
        if (!Number.isFinite(used) || !Number.isFinite(total)) return undefined;
        return {
            used_mb: used,
            total_mb: total,
            free_mb: total - used
        };
    } catch  {
        return undefined;
    }
}
export async function wait_for_free_vram(options) {
    const min_free_mb = options?.min_free_mb ?? 5_200;
    const timeout_ms = options?.timeout_ms ?? 600_000;
    const poll_ms = options?.poll_ms ?? 30_000;
    const label = options?.label ?? 'gemma';
    if (min_free_mb <= 0) return true;
    const deadline = Date.now() + timeout_ms;
    let waited = false;
    for(;;){
        const memory = gpu_memory();
        if (memory === undefined) {
            if (waited) probe('gpu', 'vram.wait_skipped', {
                label,
                reason: 'no_nvidia_smi'
            });
            return true;
        }
        if (memory.free_mb >= min_free_mb) {
            if (waited) probe('gpu', 'vram.free_now', {
                label,
                free_mb: memory.free_mb
            });
            return true;
        }
        if (Date.now() >= deadline) {
            probe('gpu', 'vram.wait_timeout', {
                label,
                free_mb: memory.free_mb,
                need_mb: min_free_mb,
                timeout_ms
            });
            return false;
        }
        if (!waited) {
            waited = true;
            probe('gpu', 'vram.busy_wait', {
                label,
                free_mb: memory.free_mb,
                need_mb: min_free_mb,
                total_mb: memory.total_mb
            });
        }
        await new Promise((resolve)=>setTimeout(resolve, Math.min(poll_ms, Math.max(0, deadline - Date.now()))));
    }
}
