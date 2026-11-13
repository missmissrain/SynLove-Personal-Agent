/**
 * Live2D待机动作库：从预载配置随机选择小动作，避免连续重复，使用平滑包络回到自然姿态。
 * 注册参数presets为动作清单，random默认Math.random；不使用其他角色的网格或贴图。
 */
export class Live2dGestureLibrary {
  /** 参数presets为本地动作配置，random为随机源；首次动作两秒后开始。 */
  constructor(presets = [], random = Math.random) {
    this.presets = presets
    this.random = random
    this.next = 2
    this.active = null
    this.recent = []
  }

  /** 参数time为累计秒数、name为可选动作名；随机选取或为预览指定动作。 */
  start_action(time, name) {
    const candidates = name ? this.presets.filter(row => row.name === name) :
      this.presets.filter(row => !this.recent.slice(-2).includes(row.name))
    if (!candidates.length) return
    const preset = candidates[Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))]
    this.active = { ...preset, start: time }
    this.recent.push(preset.name)
    this.recent = this.recent.slice(-2)
    this.next = time + preset.duration + 2 + this.random() * 3
  }

  /** 参数time为累计秒数、reduced为减少动态开关；返回当前小动作的增量参数。 */
  sample_action(time, reduced = false) {
    if (reduced) {
      this.active = null
      this.next = time + 2
      return {}
    }
    if (time >= this.next) this.start_action(time)
    if (!this.active) return {}
    const phase = (time - this.active.start) / this.active.duration
    if (phase < 0 || phase >= 1) { this.active = null; return {} }
    const smooth = x => x * x * (3 - 2 * x)
    const ramp = .2
    const envelope = smooth(Math.min(1, phase / ramp)) * smooth(Math.min(1, (1 - phase) / ramp))
    const pose = {}
    for (const [id, channel] of Object.entries(this.active.channels)) {
      const [amplitude, cycles = 0, offset = 0] = Array.isArray(channel) ? channel : [channel]
      pose[id] = amplitude * envelope * (cycles ? Math.sin(phase * Math.PI * 2 * cycles + offset) : 1)
    }
    return pose
  }
}
