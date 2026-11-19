/**
 * 画像作息：睡眠、上班、午休只从知识图谱的主人备注里读，代码里不保留默认时间。
 * 参数：无；备注里没有完整作息时视为“未配置”，不主动打扰。
 */
/** 把 "HH:MM" 换成当天分钟数；非法返回 undefined。 */
function minutes_of(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
    if (match === null) return undefined;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
    return hour * 60 + minute;
}
/** 判断 minute 是否落在 [start,end)；start>end 时按跨午夜处理。 */
function inside(now, start, end) {
    return start <= end ? now >= start && now < end : now >= start || now < end;
}
/** 画像作息。 */
export class ProfileRhythm {
    constructor() {
        this.notes_override = {};
    }
    /** 从画像备注里读作息；每次都先清空，图谱改了下一轮就生效。 */
    update_from_notes(notes) {
        this.notes_override = {};
        const rules = [
            ['sleep_start', 'sleep_end', /(?:睡眠|睡觉)[^0-9]{0,8}(\d{1,2}:\d{2})\s*[-~到至]\s*(\d{1,2}:\d{2})/],
            ['work_start', 'work_end', /(?:上班|工作)[^0-9]{0,8}(\d{1,2}:\d{2})\s*[-~到至]\s*(\d{1,2}:\d{2})/],
            ['lunch_start', 'lunch_end', /午休[^0-9]{0,8}(\d{1,2}:\d{2})\s*[-~到至]\s*(\d{1,2}:\d{2})/]
        ];
        for (const [start_key, end_key, pattern] of rules) {
            const match = pattern.exec(notes);
            if (match === null) continue;
            if (minutes_of(match[1]) === undefined || minutes_of(match[2]) === undefined) continue;
            this.notes_override = { ...this.notes_override, [start_key]: match[1], [end_key]: match[2] };
        }
    }
    /** 当前生效的作息；六项齐全才返回，缺项返回 undefined。 */
    load() {
        const config = this.notes_override;
        if (config.sleep_start === undefined || config.sleep_end === undefined || config.work_start === undefined || config.work_end === undefined || config.lunch_start === undefined || config.lunch_end === undefined) return undefined;
        return {
            sleep_start: config.sleep_start,
            sleep_end: config.sleep_end,
            work_start: config.work_start,
            work_end: config.work_end,
            lunch_start: config.lunch_start,
            lunch_end: config.lunch_end
        };
    }
    /** 图谱里是否有完整作息。 */
    is_configured() {
        return this.load() !== undefined;
    }
    /** 判断当前时段；没配置返回 unknown。 */
    moment(now) {
        const config = this.load();
        if (config === undefined) return 'unknown';
        const minute = now.getHours() * 60 + now.getMinutes();
        const sleep_start = minutes_of(config.sleep_start);
        const sleep_end = minutes_of(config.sleep_end);
        if (inside(minute, sleep_start, sleep_end)) return 'sleep';
        const lunch_start = minutes_of(config.lunch_start);
        const lunch_end = minutes_of(config.lunch_end);
        if (inside(minute, lunch_start, lunch_end)) return 'lunch';
        const work_start = minutes_of(config.work_start);
        const work_end = minutes_of(config.work_end);
        if (inside(minute, work_start, work_end)) return 'work';
        return 'free';
    }
    /** 当前是否在睡觉；没配置不算睡觉。 */
    is_sleeping(now) {
        return this.moment(now) === 'sleep';
    }
    /** 是否适合主动播报；没配置返回 false。 */
    is_good_moment(now) {
        const moment = this.moment(now);
        return moment === 'lunch' || moment === 'free';
    }
}
