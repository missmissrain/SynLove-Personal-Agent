/** 远程记忆客户端。 */
export class MemoryRemoteClient {
    base_url;
    api_key;
    timeout_ms;
    constructor(options = {}) {
        this.base_url = (options.base_url
            ?? process.env.SYNLOVE_MEMORY_BASE_URL
            ?? 'http://127.0.0.1:8797/v1').replace(/\/+$/, '');
        this.api_key = options.api_key
            ?? process.env.SYNLOVE_MEMORY_API_KEY
            ?? '';
        this.timeout_ms = Math.max(1_000, Math.min(120_000, options.timeout_ms ?? 30_000));
    }
    /** 追加一条时间线记录；返回是否真的写入。 */
    async append(entry) {
        const result = await this.call('memory_append', { entry });
        return result.written === true;
    }
    /** 按服务约定时区把时间戳转换为日期键。 */
    day_key(ts) {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(ts));
    }
    /** 列出日期索引。 */
    async list_days() {
        const result = await this.call('memory_days', { limit: 100 });
        return Array.isArray(result.days) ? result.days : [];
    }
    /** 读取某日摘要。 */
    async read_summary(date) {
        const result = await this.call('memory_read', { date, includeEntries: false });
        return typeof result.summary === 'string' && result.summary !== '' ? result.summary : undefined;
    }
    /** 读取某一天的完整时间线。 */
    async read_day(date, filter) {
        const day = await this.call('memory_read', { date, includeEntries: true });
        let entries = Array.isArray(day.entries) ? day.entries : [];
        if (filter?.user_id !== undefined)
            entries = entries.filter(item => item.user_id === filter.user_id);
        if (filter?.session_id !== undefined)
            entries = entries.filter(item => item.session_id === filter.session_id);
        const summary = typeof day.summary === 'string' && day.summary !== '' ? day.summary : undefined;
        return {
            ...summary === undefined ? {} : { summary },
            entries,
            meta: {
                date: String(day.date ?? date),
                timezone: 'Asia/Shanghai',
                entries: entries.length,
                user_entries: entries.filter(item => item.role === 'user').length,
                assistant_entries: entries.filter(item => item.role === 'assistant').length,
                updated_at: Date.now(),
            },
        };
    }
    /** 按日期和稳定 ID 更新记录字段。 */
    async update_entry(date, entry_id, patch) {
        const result = await this.call('memory_update_entry', { date, entryId: entry_id, patch });
        return result.updated === true;
    }
    /** 更新媒体附件的描述。 */
    async update_attachment_description(date, entry_id, attachment_id, description) {
        const result = await this.call('memory_update_attachment', {
            date, entryId: entry_id, attachmentId: attachment_id, description,
        });
        return result.updated === true;
    }
    /** 更新某日摘要。 */
    async update_summary(date, summary, meta) {
        const result = await this.call('memory_update_summary', { date, summary, ...meta === undefined ? {} : { meta } });
        return result.updated === true;
    }
    /** 返回已达到空闲阈值、且尚未生成摘要的日期。 */
    async days_needing_summary(now = Date.now()) {
        const dates = await this.list_days();
        const due = [];
        const idle_ms = Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? '3')) * 3_600_000;
        for (const item of dates) {
            if (item.last_ts === undefined || now - item.last_ts < idle_ms)
                continue;
            if ((await this.read_summary(item.date)) === undefined)
                due.push(item.date);
        }
        return due;
    }
    /** 调用注入的摘要器并把结果提交给远程记忆服务。 */
    async summarize_due(summarizer, now = Date.now()) {
        const updated = [];
        for (const date of await this.days_needing_summary(now)) {
            const day = await this.read_day(date);
            const result = await summarizer({
                date,
                timezone: 'Asia/Shanghai',
                entries: day.entries,
                ...day.summary === undefined ? {} : { previous_summary: day.summary },
            });
            if (await this.update_summary(date, result.text, { model: result.model ?? '' }))
                updated.push(date);
        }
        return updated;
    }
    /** 读取时间线统计。 */
    async stats() {
        const days = await this.list_days();
        const result = {
            days: days.length,
            entries: days.reduce((sum, day) => sum + day.entries, 0),
        };
        if (days.length > 0) {
            const first = days[days.length - 1]?.date;
            const last = days[0]?.date;
            if (first !== undefined)
                result.first_date = first;
            if (last !== undefined)
                result.last_date = last;
        }
        return result;
    }
    /** 按关键词搜索时间线。 */
    async search(keyword, options = {}) {
        const result = await this.call('memory_search', { keyword, limit: options.limit ?? 20 });
        const hits = Array.isArray(result.hits) ? result.hits : [];
        return hits
            .filter(hit => options.from === undefined || hit.date >= options.from)
            .filter(hit => options.to === undefined || hit.date <= options.to);
    }
    /** 读取一个日期或日期区间。 */
    async read_range(from, to, filter) {
        const end = to ?? from;
        const days = await this.list_days();
        const selected = days
            .map(item => item.date)
            .filter(date => date >= from && date <= end)
            .slice(-3);
        const result = [];
        for (const date of selected) {
            const day = await this.call('memory_read', { date, includeEntries: true });
            let entries = Array.isArray(day.entries) ? day.entries : [];
            if (filter?.user_id !== undefined)
                entries = entries.filter(item => item.user_id === filter.user_id);
            if (filter?.session_id !== undefined)
                entries = entries.filter(item => item.session_id === filter.session_id);
            const summary = typeof day.summary === 'string' && day.summary !== '' ? day.summary : undefined;
            result.push({
                ...summary === undefined ? {} : { summary },
                entries,
                meta: {
                    date: day.date,
                    timezone: 'Asia/Shanghai',
                    entries: entries.length,
                    user_entries: entries.filter(item => item.role === 'user').length,
                    assistant_entries: entries.filter(item => item.role === 'assistant').length,
                    updated_at: Date.now(),
                },
            });
        }
        return result;
    }
    /** 读取图谱快照。 */
    async snapshot() {
        const result = await this.call('graph_snapshot');
        return {
            nodes: Array.isArray(result.nodes) ? result.nodes : [],
            edges: Array.isArray(result.edges) ? result.edges : [],
        };
    }
    /** 确保图谱中心节点存在。 */
    async ensure_center() {
        await this.call('graph_ensure_center');
    }
    /** 新增或更新人物节点。 */
    async upsert_person(person) {
        const result = await this.call('graph_upsert_person', { person });
        return result.person;
    }
    /** 新增或更新关系边。 */
    async upsert_edge(edge) {
        const result = await this.call('graph_upsert_edge', { edge });
        return result.edge;
    }
    /** 读取图谱增量水位。 */
    async last_update_ms() {
        const result = await this.call('graph_watermark');
        return typeof result.ts === 'number' ? result.ts : undefined;
    }
    /** 读取同一毫秒下已处理的记录 ID。 */
    async last_update_ids() {
        const result = await this.call('graph_watermark');
        return Array.isArray(result.ids) ? result.ids.filter((id) => typeof id === 'string') : [];
    }
    /** 提交图谱增量水位。 */
    async set_last_update(ts, ids) {
        await this.call('graph_watermark', { update: { ts, ids } });
    }
    /** 找到人物节点。 */
    async find(name_or_id) {
        const snapshot = await this.snapshot();
        const needle = name_or_id.trim().toLocaleLowerCase().replace(/\s+/g, '');
        return snapshot.nodes.find(node => node.id === name_or_id
            || node.name.toLocaleLowerCase().replace(/\s+/g, '') === needle
            || (node.aliases ?? []).some(alias => alias.toLocaleLowerCase().replace(/\s+/g, '') === needle));
    }
    /** 返回全部节点。 */
    async nodes() { return [...(await this.snapshot()).nodes]; }
    /** 返回从某节点出发的边。 */
    async edges_from(id) {
        return (await this.snapshot()).edges.filter(edge => edge.from === id);
    }
    /** 返回指向某节点的边。 */
    async edges_to(id) {
        return (await this.snapshot()).edges.filter(edge => edge.to === id);
    }
    /** 返回节点属性；年龄等派生字段由服务端存储值直接提供。 */
    async attributes(name) { return this.find(name); }
    /** 返回某人的关系网。 */
    async neighborhood(name, options = {}) {
        const snapshot = await this.snapshot();
        const start = await this.find_in_snapshot(snapshot, name);
        if (start === undefined)
            return [];
        const max_depth = Math.max(1, Math.min(6, options.max_depth ?? 2));
        const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
        const outgoing = new Map();
        for (const edge of snapshot.edges)
            outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
        const seen = new Map();
        let frontier = [start.id];
        for (let depth = 1; depth <= max_depth; depth += 1) {
            const next = [];
            for (const id of frontier) {
                for (const edge of outgoing.get(id) ?? []) {
                    if (edge.to === start.id || seen.has(edge.to))
                        continue;
                    seen.set(edge.to, { name: nodes.get(edge.to)?.name ?? edge.to, label: edge.label, depth });
                    next.push(edge.to);
                }
            }
            frontier = next;
        }
        return [...seen.values()];
    }
    /** 查找两人之间的简单路径。 */
    async paths(from_name, to_name, options = {}) {
        const snapshot = await this.snapshot();
        const start = await this.find_in_snapshot(snapshot, from_name);
        const end = await this.find_in_snapshot(snapshot, to_name);
        if (start === undefined || end === undefined)
            return [];
        const max_depth = Math.max(1, Math.min(8, options.max_depth ?? 4));
        const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
        const outgoing = new Map();
        for (const edge of snapshot.edges)
            outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
        const result = [];
        const walk = (current, visited, hops) => {
            if (current === end.id && hops.length > 0) {
                result.push({
                    node_ids: [start.id, ...hops.map(edge => edge.to)],
                    names: [start.name, ...hops.map(edge => nodes.get(edge.to)?.name ?? edge.to)],
                    hops: hops.map(edge => ({ from: edge.from, to: edge.to, label: edge.label })),
                    readable: [start.name, ...hops.map(edge => nodes.get(edge.to)?.name ?? edge.to)].join(' → '),
                });
                return;
            }
            if (hops.length >= max_depth)
                return;
            for (const edge of outgoing.get(current) ?? []) {
                if (visited.has(edge.to))
                    continue;
                visited.add(edge.to);
                walk(edge.to, visited, [...hops, edge]);
                visited.delete(edge.to);
            }
        };
        walk(start.id, new Set([start.id]), []);
        return result.sort((a, b) => a.hops.length - b.hops.length);
    }
    async find_in_snapshot(snapshot, name_or_id) {
        const needle = name_or_id.trim().toLocaleLowerCase().replace(/\s+/g, '');
        return snapshot.nodes.find(node => node.id === name_or_id
            || node.name.toLocaleLowerCase().replace(/\s+/g, '') === needle
            || (node.aliases ?? []).some(alias => alias.toLocaleLowerCase().replace(/\s+/g, '') === needle));
    }
    async call(name, arguments_ = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout_ms);
        try {
            const response = await fetch(`${this.base_url}/rpc`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` },
                },
                body: JSON.stringify({
                    requestId: `memory-${crypto.randomUUID()}`,
                    message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } },
                }),
                signal: controller.signal,
            });
            if (!response.ok)
                throw new Error(`memory 服务 HTTP ${response.status}`);
            let operation = await response.json();
            while (operation.state === 'running') {
                await new Promise(resolve => setTimeout(resolve, 100));
                const id = String(operation.requestId ?? '');
                const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(id)}`, {
                    headers: this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` },
                    signal: controller.signal,
                });
                operation = await status.json();
            }
            if (operation.state !== 'done')
                throw new Error(`memory 服务任务状态 ${String(operation.state)}`);
            const result = operation.result?.result
                ?? operation.result;
            if (result?.isError === true)
                throw new Error(String(result.content ?? 'memory 服务调用失败'));
            return result?.structuredContent ?? {};
        }
        finally {
            clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=memoryRemoteClient.js.map