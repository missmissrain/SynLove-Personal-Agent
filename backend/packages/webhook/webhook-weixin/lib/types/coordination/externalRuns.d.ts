/**
 * 中断外部 agent 的**在跑进程**（opencode / codex）。
 *
 * ## 为什么需要
 *
 * 实测踩过：用户说"停止任务"，我们只 `agent.cancel()` 取消了模型那一轮，
 * 但模型之前用 `opencode` 工具起的 `opencode run --auto` 子进程**继续跑了 22 分钟**——
 * 工具调用因此一直不返回，那一轮永远收不了尾，用户只看到每 5 分钟一条"还在处理中"。
 *
 * 所以取消必须**连外部进程一起杀**：模型的 turn 是它的一部分，外部进程是另一部分。
 *
 * ## 为什么按进程名+命令行匹配，而不是记子进程句柄
 *
 * 子进程有两种来源：我们的桥（`/opencode` 聊天命令）和 harness 的 `opencode`/`codex`
 * 工具包（模型自己调的）。后者不归我们管、也没把句柄交给我们，所以只能按
 * "可执行文件名 + 命令行特征"去找。匹配规则刻意保守：
 * - 必须有 `run` 子命令（`opencode run …` / `codex exec …`）；
 * - **排除 `serve`**（那是常驻的 opencode server，杀了会把链路弄断）。
 *
 * @module dsh-webhook-weixin/external-runs
 */
/** 一次中断的结果。 */
export interface KillExternalRunsResult {
    /** 被杀掉的进程数。 */
    readonly killed: number;
    /** 被杀掉的进程 id（便于日志与回执）。 */
    readonly pids: readonly number[];
    /** 出错时的原因（不抛错——取消失败不该让控制命令本身失败）。 */
    readonly error?: string;
}
/**
 * 中断所有正在跑的外部 agent 任务。
 *
 * @returns 杀掉的进程数与 pid；任何失败都只记在 `error` 里，不抛。
 */
export declare function kill_external_runs(): KillExternalRunsResult;
//# sourceMappingURL=externalRuns.d.ts.map