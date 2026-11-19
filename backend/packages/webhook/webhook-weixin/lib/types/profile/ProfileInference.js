/**
 * 画像推断：从主人备注里解析“推断-主题”，挑一条这次该研究的，并把研究结果写回画像。
 * 参数：graph 为主人节点所在的图谱存储。
 */
/** 推断行格式：推断-主题：结论（高|中|低，YYYY-MM，未调研|已调研 YYYY-MM-DD）。 */
const PATTERN = /推断-([^：:\n；;]+)[：:]\s*([^（(]+)[（(]\s*(高|中|低)\s*[，,]\s*(\d{4}-\d{2})\s*[，,]\s*(未调研|已调研(?:\s*\d{4}-\d{2}-\d{2})?)\s*[）)]/g;
/** 解析备注里的所有推断。 */
export function parse_inferences(notes) {
    const out = [];
    PATTERN.lastIndex = 0;
    for (const match of notes.matchAll(PATTERN)) {
        const status = match[5].trim();
        const date = /(\d{4}-\d{2}-\d{2})/.exec(status)?.[1];
        out.push({
            key: match[1].trim(),
            text: match[2].trim(),
            confidence: match[3],
            evidence_month: match[4],
            status,
            ...date === undefined ? {} : { researched_at: date },
            raw: match[0]
        });
    }
    return out;
}
/** 这条推断是否适合主动查资料；性格、沟通、习惯只沉淀，不研究。 */
export function actionable(inference) {
    if (inference.text.length < 4) return false;
    return !/沟通|性格|习惯|厌恶|偏好|情绪|健康|作息/.test(`${inference.key}${inference.text}`);
}
/** 挑一条这次值得研究的推断。 */
export function pick_inference(list, now) {
    const rank = { 高: 3, 中: 2, 低: 1 };
    const fresh = (item) => {
        if (item.status === '未调研') return true;
        if (item.researched_at === undefined) return true;
        return now - Date.parse(item.researched_at) > 7 * 86_400_000;
    };
    const candidates = list.filter((item) => actionable(item) && item.confidence !== '低' && fresh(item)).sort((a, b) => {
        const fresh_a = a.status === '未调研' ? 1 : 0;
        const fresh_b = b.status === '未调研' ? 1 : 0;
        if (fresh_a !== fresh_b) return fresh_b - fresh_a;
        if (rank[a.confidence] !== rank[b.confidence]) return rank[b.confidence] - rank[a.confidence];
        return b.evidence_month.localeCompare(a.evidence_month);
    });
    return candidates[0];
}
/** 画像推断存储。 */
export class ProfileInferenceStore {
    constructor(graph) {
        this.graph = graph;
    }
    /** 读主人备注并解析推断。 */
    async read() {
        try {
            const node = await this.graph.find('主人');
            const notes = node?.notes ?? '';
            return { notes, inferences: parse_inferences(notes) };
        } catch  {
            return { notes: '', inferences: [] };
        }
    }
    /** 把某条推断标记成已调研。 */
    async mark_researched(key, date) {
        try {
            const node = await this.graph.find('主人');
            if (node === undefined) return false;
            const notes = node.notes ?? '';
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`(推断-${escaped}[：:]\\s*[^（(]+[（(]\\s*(?:高|中|低)\\s*[，,]\\s*\\d{4}-\\d{2}\\s*[，,]\\s*)` + `(未调研|已调研(?:\\s*\\d{4}-\\d{2}-\\d{2})?)(\\s*[）)])`);
            const next = notes.replace(pattern, `$1已调研 ${date}$3`);
            if (next === notes) return false;
            await this.graph.upsert_person({
                id: node.id,
                name: '主人',
                notes: next,
                evidence: { date, note: '推断研究' }
            });
            return true;
        } catch  {
            return false;
        }
    }
}
