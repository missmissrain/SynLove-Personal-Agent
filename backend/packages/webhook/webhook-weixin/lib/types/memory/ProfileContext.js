/**
 * 主人画像摘要：从知识图谱读主人备注，缓存成一段可注入系统提示的文本。
 * 只在会话绑定、图谱更新、上下文压缩后刷新，不在进程启动时读。
 */
import { createHash } from 'node:crypto';
/** 把备注整理成注入文本。 */
export function build_profile_text(notes, now = Date.now()) {
    const body = notes.trim();
    if (body === '') return '【主人画像（知识图谱）】\n暂时没有画像。';
    const date = new Date(now);
    const stamp = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` + ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `【主人画像（知识图谱，更新于 ${stamp}）】\n${body.slice(0, 1400)}`;
}
/** 画像摘要缓存。 */
export class ProfileContext {
    constructor(graph) {
        this.graph = graph;
        this.text = '';
        this.hash = '';
    }
    /** 当前缓存的摘要；还没刷新时是空串。 */
    current() {
        return this.text;
    }
    /** 重新读图谱并刷新摘要；备注没变就不重写。 */
    async refresh() {
        try {
            const node = await this.graph.find('主人');
            const notes = (node?.notes ?? '').trim();
            const next = createHash('sha256').update(notes).digest('hex');
            if (next === this.hash && this.text !== '') return this.text;
            this.hash = next;
            this.text = build_profile_text(notes);
            return this.text;
        } catch  {
            return this.text;
        }
    }
}
