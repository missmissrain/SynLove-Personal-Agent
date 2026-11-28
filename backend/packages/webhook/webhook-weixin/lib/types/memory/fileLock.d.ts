/**
 * 跨进程文件锁（时间线 / 知识图谱的写保护）。
 *
 * 为什么需要它：这两个存储都是"读完整文件 → 改 → 整体替换"的写法。
 * 两个进程同时写同一天时，后写的会覆盖先写的（实测 40 条只留下 20 条），
 * 而且 Windows 上并发 rename 还会直接报 `EPERM`。
 *
 * 实现：用 `openSync(path, 'wx')`（CREATE_NEW，**原子**）抢占一个 `.lock` 文件。
 * - 抢不到就小睡重试，直到超时；
 * - 持锁进程崩了会留下锁文件，所以带**陈旧锁接管**：看 mtime 是否超时，并检查 pid 是否还活着；
 * - 释放时先 close 再 unlink（Windows 上持有句柄时删不掉）。
 *
 * 只保护**同机多进程**；跨机器共享目录不在范围内（我们也不做）。
 *
 * @module dsh-webhook-weixin/file-lock
 */
/** 加锁选项。 */
export interface FileLockOptions {
    /** 最多等多久（毫秒），默认 10 秒。 */
    readonly timeout_ms?: number;
    /** 多久没动静就认为锁是陈旧的（毫秒），默认 30 秒。 */
    readonly stale_ms?: number;
    /** 重试间隔（毫秒），默认 20。 */
    readonly retry_ms?: number;
}
/**
 * 在锁保护下执行一段同步逻辑。
 *
 * @param target_path - 被保护的文件路径（锁文件是它 + `.lock`）。
 * @param fn - 临界区逻辑。
 * @param options - 超时与陈旧判定。
 * @returns `fn` 的返回值。
 * @throws 等不到锁时抛错——**宁可失败也不能覆盖别人的合法数据**。
 */
export declare function with_file_lock<T>(target_path: string, fn: () => T, options?: FileLockOptions): T;
/** 带重试的原子替换：Windows 上并发 rename 偶发 EPERM，重试几次即可。 */
export declare function rename_with_retry(from: string, to: string, attempts?: number): void;
//# sourceMappingURL=fileLock.d.ts.map