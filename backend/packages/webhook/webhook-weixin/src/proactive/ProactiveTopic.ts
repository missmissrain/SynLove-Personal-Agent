/**
 * 主动研究主题：从主人画像里抽出“值得定期查”的事项。
 * 参数：无；由 ProactiveStore 调用 derive_topics / merge_topics。
 */
export type TopicKind = 'flight' | 'price' | 'tech' | 'custom'

/** 一个可被后台定期查询的主题。 */
export interface ProactiveTopic {
  readonly id: string
  readonly title: string
  readonly kind: TopicKind
  readonly query: string
  readonly interval_hours: number
  readonly enabled: boolean
  readonly source: 'profile' | 'manual'
  readonly last_checked_ms?: number
  readonly last_hash?: string
}

/** 关键词到主题的规则。 */
interface TopicRule {
  readonly test: RegExp
  readonly topic: Omit<ProactiveTopic, 'enabled' | 'source'>
}

const RULES: readonly TopicRule[] = [
  {
    test: /伊斯坦布尔|土耳其|欧洲|机票|旅行|春节/,
    topic: {
      id: 'flight-istanbul', title: '伊斯坦布尔机票', kind: 'flight',
      query: '伊斯坦布尔 往返 机票 含税价格 2027年2月', interval_hours: 72,
    },
  },
  {
    test: /显卡|3090|3060|GPU|算力/,
    topic: {
      id: 'price-gpu', title: '二手显卡价格', kind: 'price',
      query: 'RTX 3090 24G 二手显卡 价格 行情', interval_hours: 72,
    },
  },
  {
    test: /MiniMax|本地部署|视频生成/,
    topic: {
      id: 'tech-minimax', title: 'MiniMax 本地部署', kind: 'tech',
      query: 'MiniMax 本地部署 最新版本 显存要求', interval_hours: 168,
    },
  },
  {
    test: /漫剧|AI短剧|短剧/,
    topic: {
      id: 'custom-comic', title: 'AI 漫剧动态', kind: 'custom',
      query: 'AI 漫剧 平台 最新 分成', interval_hours: 168,
    },
  },
]

/**
 * 按画像备注推导主题。
 *
 * @param notes - 主人节点备注（画像正文）。
 * @returns 命中的主题列表；没命中返回空数组。
 */
export function derive_topics(notes: string): ProactiveTopic[] {
  const text = notes.trim()
  if (text === '') return []
  const topics: ProactiveTopic[] = []
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue
    topics.push({ ...rule.topic, enabled: true, source: 'profile' })
  }
  return topics
}

/**
 * 把新推导的主题并进已有列表：保留手动主题与历史检查时间，失效的画像主题停用。
 *
 * @param existing - 已保存的主题。
 * @param derived - 本轮从画像推导出的主题。
 * @returns 合并后的主题列表。
 */
export function merge_topics(
  existing: readonly ProactiveTopic[],
  derived: readonly ProactiveTopic[],
): ProactiveTopic[] {
  const by_id = new Map(existing.map(item => [item.id, item]))
  const merged: ProactiveTopic[] = []
  for (const topic of derived) {
    const prior = by_id.get(topic.id)
    merged.push({
      ...topic,
      enabled: prior?.enabled ?? true,
      ...prior?.last_checked_ms === undefined ? {} : { last_checked_ms: prior.last_checked_ms },
      ...prior?.last_hash === undefined ? {} : { last_hash: prior.last_hash },
    })
    by_id.delete(topic.id)
  }
  for (const topic of by_id.values()) {
    merged.push(topic.source === 'manual' ? topic : { ...topic, enabled: false })
  }
  return merged
}

/**
 * 判断主题是否到期。
 *
 * @param topic - 待检查主题。
 * @param now - 当前毫秒时间戳。
 */
export function topic_due(topic: ProactiveTopic, now: number): boolean {
  if (!topic.enabled) return false
  if (topic.last_checked_ms === undefined) return true
  return now - topic.last_checked_ms >= topic.interval_hours * 3_600_000
}

/**
 * 不同主题的结果能保鲜多久。
 *
 * @param kind - 主题类型。
 * @returns 小时数；机票 72、显卡 48、技术和漫剧 168。
 */
export function fresh_hours_of(kind: TopicKind): number {
  switch (kind) {
    case 'flight': return 72
    case 'price': return 48
    case 'tech': return 168
    default: return 168
  }
}
