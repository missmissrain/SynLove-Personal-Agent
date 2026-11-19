/**
 * 画像作息：只从知识图谱的主人备注里读睡眠、上班、午休。
 * 参数：无；备注里没写时才用内置默认值。
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

/** 一天中的时段。 */
export type DayMoment = 'sleep' | 'work' | 'lunch' | 'free'

/** 默认作息：23:30 睡、08:00 起、09:00-18:00 上班、12:00-13:00 午休。 */
const DEFAULT_RHYTHM: RhythmConfig = {
  sleep_start: '23:00',
  sleep_end: '08:30',
  work_start: '09:00',
  work_end: '18:15',
  lunch_start: '11:45',
  lunch_end: '13:15',
}

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
  /** 从画像备注里读到的作息，优先于配置文件。 */
  private notes_override: Partial<RhythmConfig> = {}

  /**
   * 从画像备注里读作息；只认明确写出的时间。
   *
   * @param notes - 主人画像备注。
   */
  update_from_notes(notes: string): void {
    // 图谱是唯一来源：先清空旧值，备注删掉了就回到默认。
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

  /** 当前生效的作息：图谱备注覆盖内置默认值。 */
  load(): RhythmConfig {
    return { ...DEFAULT_RHYTHM, ...this.notes_override }
  }

  /** 判断当前时段：sleep / lunch / work / free。 */
  moment(now: Date): DayMoment {
    const config = this.load()
    const minute = now.getHours() * 60 + now.getMinutes()
    const sleep_start = minutes_of(config.sleep_start) ?? 23 * 60 + 30
    const sleep_end = minutes_of(config.sleep_end) ?? 8 * 60
    if (inside(minute, sleep_start, sleep_end)) return 'sleep'
    const lunch_start = minutes_of(config.lunch_start) ?? 12 * 60
    const lunch_end = minutes_of(config.lunch_end) ?? 13 * 60
    if (inside(minute, lunch_start, lunch_end)) return 'lunch'
    const work_start = minutes_of(config.work_start) ?? 9 * 60
    const work_end = minutes_of(config.work_end) ?? 18 * 60
    if (inside(minute, work_start, work_end)) return 'work'
    return 'free'
  }

  /** 当前是否在睡觉。 */
  is_sleeping(now: Date): boolean {
    return this.moment(now) === 'sleep'
  }

  /** 是否适合主动播报：午休或自由时间。 */
  is_good_moment(now: Date): boolean {
    const moment = this.moment(now)
    return moment === 'lunch' || moment === 'free'
  }
}
