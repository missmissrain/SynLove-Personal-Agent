/**
 * 画像作息：睡眠、上班、午休只从知识图谱的主人备注里读，代码里不保留默认时间。
 * 参数：无；备注里没有完整作息时视为“未配置”，不主动打扰。
 */

/** 作息配置（24 小时制 HH:MM）。 */
export interface RhythmConfig {
  readonly sleep_start: string
  readonly sleep_end: string
  readonly work_start: string
  readonly work_end: string
  readonly lunch_start: string
  readonly lunch_end: string
}

/** 一天中的时段；unknown 表示图谱里还没写作息。 */
export type DayMoment = 'sleep' | 'work' | 'lunch' | 'free' | 'unknown'

/**
 * 把 "HH:MM" 换成当天分钟数。
 *
 * @param text - 形如 "08:30" 的时间。
 * @returns 0~1439 的分钟数；格式非法返回 undefined。
 */
function minutes_of(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/**
 * 判断某一分钟是否落在 [start, end) 内。
 *
 * @param now - 当前分钟数。
 * @param start - 区间起点。
 * @param end - 区间终点；小于起点时按跨午夜处理。
 */
function inside(now: number, start: number, end: number): boolean {
  return start <= end ? now >= start && now < end : now >= start || now < end
}

/** 画像作息。 */
export class ProfileRhythm {
  /** 从画像备注里读到的作息；图谱是唯一来源。 */
  private notes_override: Partial<RhythmConfig> = {}

  /**
   * 从画像备注里读作息；每次都先清空，图谱改了下一轮就生效。
   *
   * @param notes - 主人画像备注。
   */
  update_from_notes(notes: string): void {
    this.notes_override = {}
    const rules: Array<[keyof RhythmConfig, keyof RhythmConfig, RegExp]> = [
      ['sleep_start', 'sleep_end', /(?:睡眠|睡觉)[^0-9]{0,8}(\d{1,2}:\d{2})\s*[-~到至]\s*(\d{1,2}:\d{2})/],
      ['work_start', 'work_end', /(?:上班|工作)[^0-9]{0,8}(\d{1,2}:\d{2})\s*[-~到至]\s*(\d{1,2}:\d{2})/],
      ['lunch_start', 'lunch_end', /午休[^0-9]{0,8}(\d{1,2}:\d{2})\s*[-~到至]\s*(\d{1,2}:\d{2})/],
    ]
    for (const [start_key, end_key, pattern] of rules) {
      const match = pattern.exec(notes)
      if (match === null) continue
      if (minutes_of(match[1]!) === undefined || minutes_of(match[2]!) === undefined) continue
      this.notes_override = { ...this.notes_override, [start_key]: match[1], [end_key]: match[2] }
    }
  }

  /**
   * 当前生效的作息。
   *
   * @returns 六项齐全才返回配置；缺任何一项都返回 undefined，不回退默认值。
   */
  load(): RhythmConfig | undefined {
    const config = this.notes_override
    if (config.sleep_start === undefined || config.sleep_end === undefined
      || config.work_start === undefined || config.work_end === undefined
      || config.lunch_start === undefined || config.lunch_end === undefined) return undefined
    return {
      sleep_start: config.sleep_start,
      sleep_end: config.sleep_end,
      work_start: config.work_start,
      work_end: config.work_end,
      lunch_start: config.lunch_start,
      lunch_end: config.lunch_end,
    }
  }

  /** 图谱里是否有完整作息。 */
  is_configured(): boolean {
    return this.load() !== undefined
  }

  /**
   * 判断当前时段。
   *
   * @param now - 当前时间。
   * @returns sleep / lunch / work / free；图谱没写作息时返回 unknown。
   */
  moment(now: Date): DayMoment {
    const config = this.load()
    if (config === undefined) return 'unknown'
    const minute = now.getHours() * 60 + now.getMinutes()
    const sleep_start = minutes_of(config.sleep_start)!
    const sleep_end = minutes_of(config.sleep_end)!
    if (inside(minute, sleep_start, sleep_end)) return 'sleep'
    const lunch_start = minutes_of(config.lunch_start)!
    const lunch_end = minutes_of(config.lunch_end)!
    if (inside(minute, lunch_start, lunch_end)) return 'lunch'
    const work_start = minutes_of(config.work_start)!
    const work_end = minutes_of(config.work_end)!
    if (inside(minute, work_start, work_end)) return 'work'
    return 'free'
  }

  /** 当前是否在睡觉；图谱没配置时不算睡觉。 */
  is_sleeping(now: Date): boolean {
    return this.moment(now) === 'sleep'
  }

  /** 是否适合主动播报：午休或自由时间；图谱没配置时返回 false。 */
  is_good_moment(now: Date): boolean {
    const moment = this.moment(now)
    return moment === 'lunch' || moment === 'free'
  }
}
