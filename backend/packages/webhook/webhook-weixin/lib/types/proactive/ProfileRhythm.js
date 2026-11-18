/**
 * 画像作息：把睡眠、上班、午休换算成一天里的可播报时段。
 * 参数：config_path 指向 runtime/dsh/proactive/rhythm.json；文件缺失时使用内置默认值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const DEFAULT_RHYTHM = {
    sleep_start: '23:00',
    sleep_end: '08:30',
    work_start: '09:00',
    work_end: '18:15',
    lunch_start: '11:45',
    lunch_end: '13:15'
};
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
    constructor(config_path) {
        this.config_path = config_path;
        this.notes_override = {};
    }
    /** 从画像备注里读作息；只认明确写出的时间。 */
    update_from_notes(notes) {
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
    /** 读取作息配置；文件不存在或损坏时返回默认值。 */
    load() {
        try {
            if (!existsSync(this.config_path)) return { ...DEFAULT_RHYTHM, ...this.notes_override };
            const raw = JSON.parse(readFileSync(this.config_path, 'utf8'));
            const pick = (key)=>{
                const value = typeof raw[key] === 'string' ? String(raw[key]) : '';
                return minutes_of(value) === undefined ? DEFAULT_RHYTHM[key] : value;
            };
            const file_config = {
                sleep_start: pick('sleep_start'),
                sleep_end: pick('sleep_end'),
                work_start: pick('work_start'),
                work_end: pick('work_end'),
                lunch_start: pick('lunch_start'),
                lunch_end: pick('lunch_end')
            };
            return { ...file_config, ...this.notes_override };
        } catch  {
            return { ...DEFAULT_RHYTHM, ...this.notes_override };
        }
    }
    /** 首次运行时写一份默认配置。 */
    ensure_file() {
        if (existsSync(this.config_path)) return;
        try {
            mkdirSync(dirname(this.config_path), {
                recursive: true
            });
            writeFileSync(this.config_path, JSON.stringify(DEFAULT_RHYTHM, null, 2), 'utf8');
        } catch  {
        }
    }
    /** 判断当前时段：sleep / lunch / work / free。 */
    moment(now) {
        const config = this.load();
        const minute = now.getHours() * 60 + now.getMinutes();
        const sleep_start = minutes_of(config.sleep_start) ?? 23 * 60 + 30;
        const sleep_end = minutes_of(config.sleep_end) ?? 8 * 60;
        if (inside(minute, sleep_start, sleep_end)) return 'sleep';
        const lunch_start = minutes_of(config.lunch_start) ?? 12 * 60;
        const lunch_end = minutes_of(config.lunch_end) ?? 13 * 60;
        if (inside(minute, lunch_start, lunch_end)) return 'lunch';
        const work_start = minutes_of(config.work_start) ?? 9 * 60;
        const work_end = minutes_of(config.work_end) ?? 18 * 60;
        if (inside(minute, work_start, work_end)) return 'work';
        return 'free';
    }
    /** 当前是否在睡觉。 */
    is_sleeping(now) {
        return this.moment(now) === 'sleep';
    }
    /** 是否适合主动播报：午休或自由时间。 */
    is_good_moment(now) {
        const moment = this.moment(now);
        return moment === 'lunch' || moment === 'free';
    }
}
