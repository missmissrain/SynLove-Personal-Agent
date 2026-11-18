/**
 * 主动研究主题：从主人画像里抽出“值得定期查”的事项。
 * 参数：无；由 ProactiveStore 调用 derive_topics / merge_topics。
 */
const RULES = [
    {
        test: /伊斯坦布尔|土耳其|欧洲|机票|旅行|春节/,
        topic: {
            id: 'flight-istanbul',
            title: '伊斯坦布尔机票',
            kind: 'flight',
            query: '伊斯坦布尔 往返 机票 含税价格 2027年2月',
            interval_hours: 24
        }
    },
    {
        test: /显卡|3090|3060|GPU|算力/,
        topic: {
            id: 'price-gpu',
            title: '二手显卡价格',
            kind: 'price',
            query: 'RTX 3090 24G 二手显卡 价格 行情',
            interval_hours: 12
        }
    },
    {
        test: /MiniMax|本地部署|视频生成/,
        topic: {
            id: 'tech-minimax',
            title: 'MiniMax 本地部署',
            kind: 'tech',
            query: 'MiniMax 本地部署 最新版本 显存要求',
            interval_hours: 72
        }
    },
    {
        test: /漫剧|AI短剧|短剧/,
        topic: {
            id: 'custom-comic',
            title: 'AI 漫剧动态',
            kind: 'custom',
            query: 'AI 漫剧 平台 最新 分成',
            interval_hours: 72
        }
    }
];
/** 按画像备注推导主题。 */
export function derive_topics(notes) {
    const text = notes.trim();
    if (text === '') return [];
    const topics = [];
    for (const rule of RULES) {
        if (!rule.test.test(text)) continue;
        topics.push({
            ...rule.topic,
            enabled: true,
            source: 'profile'
        });
    }
    return topics;
}
/** 合并主题：保留手动主题与历史检查时间，失效的画像主题停用。 */
export function merge_topics(existing, derived) {
    const by_id = new Map(existing.map((item)=>[
            item.id,
            item
        ]));
    const merged = [];
    for (const topic of derived) {
        const prior = by_id.get(topic.id);
        merged.push({
            ...topic,
            enabled: prior?.enabled ?? true,
            ...prior?.last_checked_ms === undefined ? {} : {
                last_checked_ms: prior.last_checked_ms
            },
            ...prior?.last_hash === undefined ? {} : {
                last_hash: prior.last_hash
            }
        });
        by_id.delete(topic.id);
    }
    for (const topic of by_id.values()) {
        merged.push(topic.source === 'manual' ? topic : {
            ...topic,
            enabled: false
        });
    }
    return merged;
}
/** 判断主题是否到期。 */
export function topic_due(topic, now) {
    if (!topic.enabled) return false;
    if (topic.last_checked_ms === undefined) return true;
    return now - topic.last_checked_ms >= topic.interval_hours * 3_600_000;
}
