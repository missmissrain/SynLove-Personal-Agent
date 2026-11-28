import { probe } from '../diagnostics/probe.js';
import { wait_for_free_vram } from './gpuMonitor.js';
export function create_gemma_gate(options) {
    const concurrency = Math.max(1, options?.concurrency ?? 1);
    const max_queue = Math.max(0, options?.max_queue ?? 20);
    const wait_timeout_ms = options?.wait_timeout_ms ?? 600_000;
    let active = 0;
    const queue = [];
    const release = ()=>{
        active -= 1;
        const next = queue.shift();
        if (next !== undefined) next();
    };
    return {
        async run (label, fn) {
            const vram_ok = await wait_for_free_vram({
                min_free_mb: options?.min_free_vram_mb ?? 5_200,
                timeout_ms: options?.vram_wait_ms ?? 600_000,
                poll_ms: options?.vram_poll_ms ?? 30_000,
                label
            });
            if (!vram_ok) {
                throw new Error(`显存一直被占用，暂缓「${label}」（等不到至少 ${options?.min_free_vram_mb ?? 5_200}MB 空闲）。稍后会自动重试。`);
            }
            if (options?.ensure_ready !== undefined) await options.ensure_ready();
            if (active >= concurrency) {
                if (queue.length >= max_queue) {
                    probe('gemma', 'gate.rejected', {
                        label,
                        active,
                        queued: queue.length
                    });
                    throw new Error(`Gemma 调用排队已满（${max_queue}），本次「${label}」跳过。`);
                }
                await new Promise((resolve, reject)=>{
                    const timer = setTimeout(()=>{
                        const at = queue.indexOf(entry);
                        if (at >= 0) queue.splice(at, 1);
                        reject(new Error(`等待 Gemma 闸门超时（${wait_timeout_ms}ms）：${label}`));
                    }, wait_timeout_ms);
                    const entry = ()=>{
                        clearTimeout(timer);
                        resolve();
                    };
                    queue.push(entry);
                });
            }
            active += 1;
            probe('gemma', 'gate.enter', {
                label,
                active,
                queued: queue.length
            });
            try {
                return await fn();
            } finally{
                release();
                probe('gemma', 'gate.leave', {
                    label,
                    active,
                    queued: queue.length
                });
            }
        },
        stats: ()=>({
                active,
                queued: queue.length
            })
    };
}
