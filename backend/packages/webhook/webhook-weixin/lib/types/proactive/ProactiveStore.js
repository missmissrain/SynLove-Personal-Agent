/**
 * 主动研究的本地状态：主题、待播卡片、每日预算。
 * 参数：dir 为 runtime/dsh/proactive；所有文件都放在这个目录下。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { derive_topics, merge_topics } from './ProactiveTopic.js';
/** 本地日期（YYYY-MM-DD）。 */
function local_day(now) {
    const date = new Date(now);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
/** 主动研究本地状态。 */
export class ProactiveStore {
    constructor(dir) {
        this.dir = dir;
        mkdirSync(this.dir, {
            recursive: true
        });
    }
    /** 拼出状态文件路径。 */
    file(name) {
        return join(this.dir, name);
    }
    /** 读取主题列表；文件损坏时返回空。 */
    topics() {
        try {
            const path = this.file('topics.json');
            if (!existsSync(path)) return [];
            const data = JSON.parse(readFileSync(path, 'utf8'));
            return Array.isArray(data.topics) ? data.topics.filter((item)=>typeof item?.id === 'string') : [];
        } catch  {
            return [];
        }
    }
    /** 保存主题列表。 */
    save_topics(topics) {
        writeFileSync(this.file('topics.json'), JSON.stringify({
            version: 1,
            topics
        }, null, 2), 'utf8');
    }
    /** 按最新画像同步主题，返回同步后的列表。 */
    sync_profile(notes) {
        const merged = merge_topics(this.topics(), derive_topics(notes));
        this.save_topics(merged);
        return merged;
    }
    /** 读取所有卡片。 */
    cards() {
        try {
            const path = this.file('cards.jsonl');
            if (!existsSync(path)) return [];
            const out = [];
            for (const line of readFileSync(path, 'utf8').split('\n')){
                if (line.trim() === '') continue;
                try {
                    const card = JSON.parse(line);
                    if (typeof card?.id === 'string' && typeof card.text === 'string') out.push(card);
                } catch  {
                }
            }
            return out;
        } catch  {
            return [];
        }
    }
    /** 追加一张卡片，并把文件控制在 300 行以内。 */
    append_card(card) {
        const path = this.file('cards.jsonl');
        appendFileSync(path, JSON.stringify(card) + '\n', 'utf8');
        try {
            const lines = readFileSync(path, 'utf8').split('\n').filter((line)=>line.trim() !== '');
            if (lines.length > 300) writeFileSync(path, lines.slice(-200).join('\n') + '\n', 'utf8');
        } catch  {
        }
    }
    /** 标记卡片已播。 */
    mark_sent(id, sent_at) {
        this.rewrite_cards((card)=>card.id === id ? {
                ...card,
                status: 'sent',
                sent_at
            } : card);
    }
    /** 把超过保留期的待播卡片标成过期。 */
    expire(max_age_ms, now) {
        this.rewrite_cards((card)=>card.status === 'pending' && now - card.created_at > max_age_ms ? {
                ...card,
                status: 'expired'
            } : card);
    }
    /** 重写卡片文件。 */
    rewrite_cards(change) {
        const cards = this.cards().map(change);
        writeFileSync(this.file('cards.jsonl'), cards.map((card)=>JSON.stringify(card)).join('\n') + '\n', 'utf8');
    }
    /** 读取调度状态。 */
    state() {
        try {
            const path = this.file('state.json');
            if (!existsSync(path)) return {
                version: 1,
                day: local_day(Date.now()),
                searches: 0
            };
            const raw = JSON.parse(readFileSync(path, 'utf8'));
            return {
                version: 1,
                day: typeof raw.day === 'string' ? raw.day : local_day(Date.now()),
                searches: Number(raw.searches ?? 0),
                ...typeof raw.profile_hash === 'string' ? {
                    profile_hash: raw.profile_hash
                } : {},
                ...typeof raw.last_delivery_at === 'number' ? {
                    last_delivery_at: raw.last_delivery_at
                } : {},
                ...typeof raw.next_research_at === 'number' ? {
                    next_research_at: raw.next_research_at
                } : {}
            };
        } catch  {
            return {
                version: 1,
                day: local_day(Date.now()),
                searches: 0
            };
        }
    }
    /** 合并写入调度状态。 */
    set_state(patch) {
        writeFileSync(this.file('state.json'), JSON.stringify({
            ...this.state(),
            ...patch,
            version: 1
        }, null, 2), 'utf8');
    }
    /** 当天还有没有搜索额度。 */
    has_budget(now, max) {
        const state = this.state();
        const day = local_day(now);
        const searches = state.day === day ? state.searches : 0;
        return searches < max;
    }
    /** 消耗一次当日搜索额度。 */
    consume_budget(now) {
        const state = this.state();
        const day = local_day(now);
        const searches = state.day === day ? state.searches : 0;
        this.set_state({ day, searches: searches + 1 });
    }
    /** 占用一次当日搜索额度；额度用完返回 false。 */
    bump_budget(now, max) {
        if (!this.has_budget(now, max)) return false;
        this.consume_budget(now);
        return true;
    }
    /** 是否存在强制跑一次的标记。 */
    force_requested() {
        return existsSync(this.file('force-once'));
    }
    /** 是否存在“强制提醒一次”的标记。 */
    force_nudge_requested() {
        return existsSync(this.file('force-nudge'));
    }
    /** 删除强制提醒标记。 */
    clear_force_nudge() {
        try {
            unlinkSync(this.file('force-nudge'));
        } catch  {
        }
    }
    /** 这条推断是否在跳过期内。 */
    skipped(key, now) {
        try {
            const path = this.file('skip.json');
            if (!existsSync(path)) return false;
            const data = JSON.parse(readFileSync(path, 'utf8'));
            return Number(data[key] ?? 0) > now;
        } catch  {
            return false;
        }
    }
    /** 标记一条推断在一段时间内不再尝试；until 传 0 表示清除。 */
    mark_skipped(key, until) {
        try {
            const path = this.file('skip.json');
            const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
            data[key] = until;
            writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
        } catch  {
        }
    }
    /** 删除强制标记。 */
    clear_force() {
        try {
            unlinkSync(this.file('force-once'));
        } catch  {
        }
    }
    /** 稳定哈希。 */
    static hash(text) {
        return createHash('sha256').update(text).digest('hex');
    }
}
