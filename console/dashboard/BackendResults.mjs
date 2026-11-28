/**
 * 远端通知本机接收调度。参数project/python为生产目录和现有Python；定期拉取，不安装依赖。
 * 用独立进程做网络等待，禁止重入，子进程静默运行，退出时结束自己的子进程。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export class BackendResults {
  /** project为生产根目录；python为已安装解释器；home为唯一实例状态目录。 */
  constructor(project, python, home) {
    this.project = project
    this.python = python
    this.home = home
    this.child = null
  }

  /** 无参数；每30秒触发一批，网络慢时等待上一批结束，不并行堆积。 */
  start_receiving() {
    const tick = () => {
      if (this.child) return
      const child = spawn(this.python, ['-m', 'microServices.NotificationPuller'], {
        cwd: this.project, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, PYTHONUTF8: '1', DSH_HOME: this.home },
      })
      this.child = child
      const timeout = setTimeout(() => child.kill(), 240_000)
      child.once('error', () => { clearTimeout(timeout); this.child = null })
      child.once('exit', () => { clearTimeout(timeout); this.child = null })
    }
    tick()
    this.timer = setInterval(tick, 30_000)
    this.timer.unref()
  }

  /** 无参数；停止本机接收器，不停止或修改远端调度器。 */
  stop_receiving() {
    clearInterval(this.timer)
    this.child?.kill()
  }
}
