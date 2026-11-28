/**
 * 开屏时间策略：完整启动首次显示必播，托盘恢复满一小时才重播，三段视频依次轮换。
 * 注册参数 file：独立的桌面状态 JSON 路径；now：时间回调，默认 Date.now；idleMs：默认 3600000ms。
 * 只保存窗口时间和下次视频序号；连续隐藏事件不覆盖离开起点，未触发播放不推进轮换。
 */
const { readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')

class OpeningPlaybackState {
  /** 参数 file/now/idleMs：持久化位置、时钟和重播间隔；恢复上次离开时间。 */
  constructor({ file, now = Date.now, idleMs = 3600000 }) {
    this.file = file
    this.now = now
    this.idleMs = idleMs
    this.active = false
    this.known = false
    this.inactiveAt = 0
    this.shownAt = 0
    this.sources = ['/assets/Opening.mp4', '/assets/Opening2.mp4', '/assets/Opening3.mp4']
    this.next = 0
    this.decision = { requestId: 0, play: false }
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'))
      if (Number.isInteger(state.next) && state.next >= 0 && state.next < this.sources.length) {
        this.next = state.next
      }
      if (Number.isFinite(state.inactiveAt) && state.inactiveAt > 0) {
        this.inactiveAt = state.inactiveAt
        this.known = true
      } else if (Number.isFinite(state.shownAt) && state.shownAt > 0) {
        // 非正常退出没有关闭事件时，以上次展示时间作为保守的恢复参考。
        this.inactiveAt = state.shownAt
        this.known = true
      }
      this.shownAt = Number.isFinite(state.shownAt) ? state.shownAt : 0
    } catch { /* 首次启动或状态损坏时播放一次，不影响窗口启动。 */ }
  }

  /** 无参数；本进程首次显示或离开满一小时返回播放请求，重复 show/restore 不重复触发。 */
  record_open() {
    if (this.active) return this.decision
    const now = this.now()
    this.decision = { requestId: this.decision.requestId + 1,
      play: this.decision.requestId === 0 || !this.known || now - this.inactiveAt >= this.idleMs }
    if (this.decision.play) {
      this.decision.source = this.sources[this.next]
      this.next = (this.next + 1) % this.sources.length
    }
    this.active = true
    this.known = true
    this.shownAt = now
    this.save_state()
    return this.decision
  }

  /** 无参数；记录隐藏、最小化或退出时刻，重复事件保留最早的离开时间。 */
  record_inactive() {
    if (!this.active) return
    this.active = false
    this.inactiveAt = this.now()
    this.save_state()
  }

  /** 无参数；原子保存少量桌面状态，磁盘异常不阻断 GUI 操作。 */
  save_state() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify({ shownAt: this.shownAt,
        inactiveAt: this.active ? null : this.inactiveAt, next: this.next }), 'utf8')
      renameSync(temp, this.file)
    } catch { /* 失败后仍使用当前进程的内存时间策略。 */ }
  }
}

module.exports = { OpeningPlaybackState }
