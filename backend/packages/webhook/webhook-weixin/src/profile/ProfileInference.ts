/**
 * 画像推断：从主人备注里解析“推断-主题”，挑一条这次该研究的，并把研究结果写回画像。
 * 参数：graph 为主人节点所在的图谱存储。
 */

/** 一条画像推断。 */
export interface ProfileInference {
  readonly key: string
  readonly text: string
  readonly confidence: '高' | '中' | '低'
  readonly evidence_month: string
  readonly status: string
  readonly researched_at?: string
  readonly raw: string
}

/** 一次画像快照。 */
export interface ProfileSnapshot {
  readonly notes: string
  readonly inferences: ProfileInference[]
}

/** 画像只读 + 备注写回接口。 */
export interface ProfileGraphLike {
  find(name: string): Promise<{ readonly id: string; readonly notes?: string } | undefined>
  upsert_person(input: {
    readonly id?: string
    readonly name: string
    readonly notes?: string
    readonly evidence?: { readonly date: string; readonly note: string }
  }): Promise<unknown>
}

/** 推断行格式：推断-主题：结论（高|中|低，YYYY-MM，未调研|已调研 YYYY-MM-DD）。 */
const PATTERN = /推断-([^：:\n；;]+)[：:]\s*([^（(]+)[（(]\s*(高|中|低)\s*[，,]\s*(\d{4}-\d{2})\s*[，,]\s*(未调研|已调研(?:\s*\d{4}-\d{2}-\d{2})?)\s*[）)]/g

/**
 * 解析备注里的所有推断。
 *
 * @param notes - 主人备注。
 * @returns 推断列表；格式不对的行忽略。
 */
export function parse_inferences(notes: string): ProfileInference[] {
  const out: ProfileInference[] = []
  PATTERN.lastIndex = 0
  for (const match of notes.matchAll(PATTERN)) {
    const status = match[5]!.trim()
    const date = /(\d{4}-\d{2}-\d{2})/.exec(status)?.[1]
    out.push({
      key: match[1]!.trim(),
      text: match[2]!.trim(),
      confidence: match[3]! as '高' | '中' | '低',
      evidence_month: match[4]!,
      status,
      ...date === undefined ? {} : { researched_at: date },
      raw: match[0],
    })
  }
  return out
}

/**
 * 这条推断是否适合主动查资料；性格、沟通、习惯只沉淀，不研究。
 *
 * @param inference - 待判断推断。
 */
export function actionable(inference: ProfileInference): boolean {
  if (inference.text.length < 4) return false
  return !/沟通|性格|习惯|厌恶|偏好|情绪|健康|作息/.test(`${inference.key}${inference.text}`)
}

/**
 * 挑一条这次值得研究的推断。
 *
 * @param list - 所有推断。
 * @param now - 当前毫秒时间戳。
 * @returns 选中的推断；没有就返回 undefined。
 */
export function pick_inference(
  list: readonly ProfileInference[],
  now: number,
  is_fresh?: (item: ProfileInference) => boolean,
): ProfileInference | undefined {
  const rank = { 高: 3, 中: 2, 低: 1 }
  const candidates = list
    .filter(item => actionable(item) && item.confidence !== '低')
    // 外部用记事簿判断“是不是还有效”；这里再兜一层 24 小时内不重复。
    .filter(item => !(is_fresh?.(item) ?? false))
    .filter(item => item.researched_at === undefined || now - Date.parse(item.researched_at) >= 86_400_000)
    .sort((a, b) => {
      const fresh_a = a.status === '未调研' ? 1 : 0
      const fresh_b = b.status === '未调研' ? 1 : 0
      if (fresh_a !== fresh_b) return fresh_b - fresh_a
      if (rank[a.confidence] !== rank[b.confidence]) return rank[b.confidence] - rank[a.confidence]
      return b.evidence_month.localeCompare(a.evidence_month)
    })
  return candidates[0]
}

/** 画像推断存储。 */
export class ProfileInferenceStore {
  constructor(private readonly graph: ProfileGraphLike) {}

  /** 读主人备注并解析推断。 */
  async read(): Promise<ProfileSnapshot> {
    try {
      const node = await this.graph.find('主人')
      const notes = node?.notes ?? ''
      return { notes, inferences: parse_inferences(notes) }
    } catch {
      return { notes: '', inferences: [] }
    }
  }

  /**
   * 把某条推断标记成已调研。
   *
   * @param key - 推断主题。
   * @param date - 调研日期 YYYY-MM-DD。
   * @returns 是否真的改动了备注。
   */
  async mark_researched(key: string, date: string): Promise<boolean> {
    try {
      const node = await this.graph.find('主人')
      if (node === undefined) return false
      const notes = node.notes ?? ''
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(
        `(推断-${escaped}[：:]\\s*[^（(]+[（(]\\s*(?:高|中|低)\\s*[，,]\\s*\\d{4}-\\d{2}\\s*[，,]\\s*)`
        + `(未调研|已调研(?:\\s*\\d{4}-\\d{2}-\\d{2})?)(\\s*[）)])`,
      )
      const next = notes.replace(pattern, `$1已调研 ${date}$3`)
      if (next === notes) return false
      await this.graph.upsert_person({
        id: node.id,
        name: '主人',
        notes: next,
        evidence: { date, note: '推断研究' },
      })
      return true
    } catch {
      return false
    }
  }
}
