const SENTENCE_BOUNDARIES = new Set([
    '。',
    '！',
    '!',
    '？',
    '?'
]);
const KEPT = new Set([
    '！',
    '!',
    '？',
    '?'
]);
const MIN_SEGMENT_CHARS = 40;
const MAX_SEGMENTS_PER_TURN = 4;
const THINK_TAG = /<\/?think[^<>]*>/gi;
const THINK_TAG_TAIL = /<\/?think[^<>]*$/i;
function looks_like_tool_call(text) {
    const trimmed = text.trimStart();
    if (/FunctionCall(Begin|End)?/.test(trimmed)) return true;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    return /"(name|arguments|parameters|tool_call|tool_calls|function)"\s*:/.test(trimmed);
}
export class ReplyAggregator {
    pending = '';
    reasoning = '';
    suppressed = false;
    finished = false;
    emitted = 0;
    accept_chunk(text) {
        if (this.finished || !text) return [];
        if (this.suppressed || looks_like_tool_call(this.pending + text)) {
            this.suppressed = true;
            this.pending = '';
            return [];
        }
        this.pending = (this.pending + text).replace(THINK_TAG, '');
        if (THINK_TAG_TAIL.test(this.pending)) return [];
        if (this.emitted >= MAX_SEGMENTS_PER_TURN) return [];
        return this.extract();
    }
    accept_reasoning(text) {
        this.reasoning = (this.reasoning + text).slice(-4000);
    }
    take_reasoning_excerpt(limit) {
        const text = this.reasoning.replace(/\s+/g, ' ').trim();
        if (!text) return undefined;
        this.reasoning = '';
        return text.length > limit ? '…' + text.slice(-limit) : text;
    }
    finish() {
        if (this.finished) return undefined;
        this.finished = true;
        if (this.suppressed) return undefined;
        const tail = this.pending.trim();
        this.pending = '';
        return tail || undefined;
    }
    get is_suppressed() {
        return this.suppressed;
    }
    extract() {
        const segments = [];
        let start = 0;
        let index = 0;
        let in_code = false;
        while(index < this.pending.length){
            if (this.pending.startsWith('```', index)) {
                in_code = !in_code;
                index += 3;
                continue;
            }
            if (!in_code && SENTENCE_BOUNDARIES.has(this.pending[index])) {
                let end = index + 1;
                let kept = '';
                if (KEPT.has(this.pending[index])) {
                    while(end < this.pending.length && KEPT.has(this.pending[end]))end += 1;
                    kept = this.pending.slice(index, end);
                }
                const segment = (this.pending.slice(start, index).trim() + kept).trim();
                if (segment.length >= MIN_SEGMENT_CHARS && this.emitted < MAX_SEGMENTS_PER_TURN) {
                    segments.push(segment);
                    this.emitted += 1;
                    start = end;
                    index = end;
                    continue;
                }
                index = end;
                continue;
            }
            index += 1;
        }
        this.pending = this.pending.slice(start);
        return segments;
    }
}
