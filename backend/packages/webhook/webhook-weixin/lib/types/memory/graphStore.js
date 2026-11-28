import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
import { rename_with_retry, with_file_lock } from './fileLock.js';
import { GRAPH_ASSISTANT_NAME, GRAPH_USER_NAME } from './graphTypes.js';
const DEFAULT_MAX_DEPTH = 4;
export class KnowledgeGraphStore {
    dir;
    tmp_seq = 0;
    constructor(options){
        this.dir = options.dir;
        mkdirSync(this.dir, {
            recursive: true
        });
    }
    nodes() {
        return read_jsonl(this.nodes_path());
    }
    edges() {
        return read_jsonl(this.edges_path());
    }
    snapshot() {
        return {
            nodes: this.nodes(),
            edges: this.edges()
        };
    }
    find(name_or_id) {
        const needle = normalize(name_or_id);
        if (needle === '') return undefined;
        return this.nodes().find((node)=>node.id === name_or_id || normalize(node.name) === needle || (node.aliases ?? []).some((alias)=>normalize(alias) === needle));
    }
    edges_from(id) {
        return this.edges().filter((edge)=>edge.from === id);
    }
    edges_to(id) {
        return this.edges().filter((edge)=>edge.to === id);
    }
    paths(from_name, to_name, options) {
        const start = this.find(from_name);
        const end = this.find(to_name);
        if (start === undefined || end === undefined) return [];
        const max_depth = Math.max(1, Math.min(8, options?.max_depth ?? DEFAULT_MAX_DEPTH));
        const nodes = new Map(this.nodes().map((node)=>[
                node.id,
                node
            ]));
        const outgoing = new Map();
        for (const edge of this.edges()){
            const list = outgoing.get(edge.from) ?? [];
            list.push(edge);
            outgoing.set(edge.from, list);
        }
        const results = [];
        const walk = (current, visited, hops)=>{
            if (current === end.id && hops.length > 0) {
                results.push(build_path(hops, nodes));
                return;
            }
            if (hops.length >= max_depth) return;
            for (const edge of outgoing.get(current) ?? []){
                if (visited.has(edge.to)) continue;
                if (edge.to === end.id) {
                    results.push(build_path([
                        ...hops,
                        edge
                    ], nodes));
                    continue;
                }
                visited.add(edge.to);
                walk(edge.to, visited, [
                    ...hops,
                    edge
                ]);
                visited.delete(edge.to);
            }
        };
        walk(start.id, new Set([
            start.id
        ]), []);
        return results.sort((a, b)=>a.hops.length - b.hops.length);
    }
    neighborhood(name, options) {
        const start = this.find(name);
        if (start === undefined) return [];
        const max_depth = Math.max(1, Math.min(6, options?.max_depth ?? 2));
        const nodes = new Map(this.nodes().map((node)=>[
                node.id,
                node
            ]));
        const outgoing = new Map();
        for (const edge of this.edges()){
            const list = outgoing.get(edge.from) ?? [];
            list.push(edge);
            outgoing.set(edge.from, list);
        }
        const seen = new Map();
        let frontier = [
            start.id
        ];
        for(let depth = 1; depth <= max_depth; depth += 1){
            const next = [];
            for (const id of frontier){
                for (const edge of outgoing.get(id) ?? []){
                    if (edge.to === start.id || seen.has(edge.to)) continue;
                    seen.set(edge.to, {
                        name: nodes.get(edge.to)?.name ?? edge.to,
                        label: edge.label,
                        depth
                    });
                    next.push(edge.to);
                }
            }
            frontier = next;
        }
        return [
            ...seen.values()
        ];
    }
    attributes(name) {
        const node = this.find(name);
        if (node === undefined) return undefined;
        const age = node.age ?? age_from_birthday(node.birthday);
        return age === undefined ? node : {
            ...node,
            age
        };
    }
    ensure_center() {
        const user_exists = this.find(GRAPH_USER_NAME) !== undefined;
        let changed = false;
        const migrated = this.nodes().map((node)=>{
            let next = node;
            if (!user_exists && normalize(node.name) === '我') {
                next = strip_undefined({
                    ...next,
                    name: GRAPH_USER_NAME,
                    aliases: merge_list(next.aliases, [
                        '我'
                    ])
                });
                probe('graph', 'center.migrated_self', {
                    id: node.id
                });
            }
            if (next.status === 'unknown') next = strip_undefined({
                ...next,
                status: undefined
            });
            if (next !== node) changed = true;
            return next;
        });
        if (changed) this.write_nodes(migrated);
        for (const name of [
            GRAPH_ASSISTANT_NAME,
            GRAPH_USER_NAME
        ]){
            if (this.find(name) === undefined) {
                this.upsert_person({
                    name,
                    evidence: {
                        date: today(),
                        note: '图谱中心节点'
                    }
                });
                probe('graph', 'center.created', {
                    name
                });
            }
        }
        this.upsert_edge({
            from: GRAPH_ASSISTANT_NAME,
            to: GRAPH_USER_NAME,
            label: GRAPH_USER_NAME,
            kind: 'address'
        });
        this.upsert_edge({
            from: GRAPH_USER_NAME,
            to: GRAPH_ASSISTANT_NAME,
            label: GRAPH_ASSISTANT_NAME,
            kind: 'address'
        });
    }
    upsert_person(input) {
        return with_file_lock(this.nodes_path(), ()=>this.upsert_person_locked(input));
    }
    upsert_person_locked(input) {
        const existing = input.id === undefined ? this.find(input.name) : this.nodes().find((n)=>n.id === input.id);
        const nodes = this.nodes();
        const now = Date.now();
        if (existing === undefined) {
            const node = strip_undefined({
                id: this.next_id(),
                name: input.name.trim(),
                aliases: input.aliases,
                birthday: input.birthday,
                age: input.age,
                gender: input.gender,
                status: input.status,
                contacts: input.contacts,
                location: input.location,
                occupation: input.occupation,
                family_summary: input.family_summary,
                important_dates: input.important_dates,
                notes: input.notes,
                updated_at: now,
                sources: input.evidence === undefined ? undefined : [
                    input.evidence
                ]
            });
            nodes.push(node);
            this.write_nodes(nodes);
            probe('graph', 'person.created', {
                id: node.id,
                name: node.name
            });
            return node;
        }
        const requested = input.name.trim();
        const renaming = input.id !== undefined && requested !== '' && normalize(requested) !== normalize(existing.name);
        const merged = strip_undefined({
            ...existing,
            name: input.id === undefined || requested === '' ? existing.name : requested,
            aliases: merge_list(renaming ? merge_list(existing.aliases, [
                existing.name
            ]) : existing.aliases, input.aliases),
            birthday: input.birthday ?? existing.birthday,
            age: input.age ?? existing.age,
            gender: input.gender ?? existing.gender,
            status: input.status ?? existing.status,
            contacts: merge_list(existing.contacts, input.contacts),
            location: input.location ?? existing.location,
            occupation: input.occupation ?? existing.occupation,
            family_summary: input.family_summary ?? existing.family_summary,
            important_dates: merge_dates(existing.important_dates, input.important_dates),
            notes: input.notes ?? existing.notes,
            updated_at: now,
            sources: merge_evidence(existing.sources, input.evidence)
        });
        this.write_nodes(nodes.map((node)=>node.id === existing.id ? merged : node));
        probe('graph', 'person.updated', {
            id: merged.id,
            name: merged.name
        });
        return merged;
    }
    upsert_edge(input) {
        return with_file_lock(this.edges_path(), ()=>this.upsert_edge_locked(input));
    }
    upsert_edge_locked(input) {
        const from = this.find(input.from);
        const to = this.find(input.to);
        if (from === undefined || to === undefined) {
            probe('graph', 'edge.missing_person', {
                from: input.from,
                to: input.to
            });
            return undefined;
        }
        if (from.id === to.id) return undefined;
        const edges = this.edges();
        const label = input.label.trim();
        if (label === '') return undefined;
        const now = Date.now();
        const address = edges.find((edge)=>edge.from === from.id && edge.to === to.id && edge.kind === 'address');
        if (input.kind === 'address' && address !== undefined && address.label !== label) {
            const merged = strip_undefined({
                ...address,
                label,
                previous_labels: [
                    address.label,
                    ...address.previous_labels ?? []
                ].slice(0, 8),
                updated_at: now,
                sources: merge_evidence(address.sources, input.evidence)
            });
            this.write_edges(edges.map((edge)=>edge === address ? merged : edge));
            probe('graph', 'edge.address_updated', {
                from: from.name,
                to: to.name,
                before: address.label,
                after: label
            });
            return merged;
        }
        const existing = edges.find((edge)=>edge.from === from.id && edge.to === to.id && edge.label === label);
        if (existing === undefined) {
            const edge = strip_undefined({
                from: from.id,
                to: to.id,
                label,
                kind: input.kind,
                updated_at: now,
                sources: input.evidence === undefined ? undefined : [
                    input.evidence
                ]
            });
            edges.push(edge);
            this.write_edges(edges);
            probe('graph', 'edge.created', {
                from: from.name,
                to: to.name,
                label
            });
            return edge;
        }
        const merged = strip_undefined({
            ...existing,
            kind: input.kind ?? existing.kind,
            updated_at: now,
            sources: merge_evidence(existing.sources, input.evidence)
        });
        this.write_edges(edges.map((edge)=>edge === existing ? merged : edge));
        return merged;
    }
    to_markdown() {
        const nodes = this.nodes();
        const edges = this.edges();
        const by_id = new Map(nodes.map((node)=>[
                node.id,
                node
            ]));
        const lines = [
            '# 人物关系图',
            '',
            `节点 ${nodes.length} · 称呼 ${edges.length}`,
            ''
        ];
        for (const node of nodes){
            lines.push(`## ${node.name}（${node.id}）`);
            lines.push('');
            lines.push(`- 别名：${(node.aliases ?? []).join('、') || '—'}`);
            lines.push(`- 生日：${node.birthday ?? '—'}　年龄：${node.age ?? age_from_birthday(node.birthday) ?? '—'}`);
            lines.push(`- 性别：${node.gender ?? '—'}　状态：${node.status ?? 'unknown'}`);
            lines.push(`- 职业：${node.occupation ?? '—'}　所在地：${node.location ?? '—'}`);
            lines.push(`- 联系方式：${(node.contacts ?? []).join('、') || '—'}`);
            lines.push(`- 家庭情况：${node.family_summary ?? '—'}`);
            if ((node.important_dates ?? []).length > 0) {
                lines.push(`- 重要日期：${(node.important_dates ?? []).map((d)=>`${d.label} ${d.date}`).join('；')}`);
            }
            if (node.notes !== undefined) lines.push(`- 备注：${node.notes}`);
            const out = edges.filter((edge)=>edge.from === node.id);
            if (out.length > 0) {
                lines.push('');
                lines.push('他/她是这样称呼别人的：');
                for (const edge of out)lines.push(`- → ${by_id.get(edge.to)?.name ?? edge.to}：${edge.label}`);
            }
            lines.push('');
        }
        return lines.join('\n');
    }
    regenerate_view() {
        this.write_atomic(join(this.dir, 'graph.md'), `${this.to_markdown()}\n`);
    }
    stats() {
        return {
            people: this.nodes().length,
            relations: this.edges().length
        };
    }
    dir_path() {
        return this.dir;
    }
    reset_watermark() {
        const index = this.load_index();
        const { last_update_ms, last_update_ids, ...rest } = index;
        this.save_index(rest);
        probe('graph', 'watermark.reset', {
            previous: last_update_ms ?? 0
        });
    }
    nodes_path() {
        return join(this.dir, 'nodes.jsonl');
    }
    edges_path() {
        return join(this.dir, 'edges.jsonl');
    }
    index_path() {
        return join(this.dir, 'index.json');
    }
    last_update_ms() {
        return this.load_index().last_update_ms;
    }
    last_update_ids() {
        return this.load_index().last_update_ids ?? [];
    }
    set_last_update(ts, ids = []) {
        const index = this.load_index();
        const previous = index.last_update_ms ?? 0;
        if (ts < previous) return;
        const same_moment = ts === previous ? [
            ...new Set([
                ...index.last_update_ids ?? [],
                ...ids
            ])
        ] : [
            ...new Set(ids)
        ];
        this.save_index({
            ...index,
            last_update_ms: ts,
            last_update_ids: same_moment.slice(-200)
        });
    }
    next_id() {
        const index = this.load_index();
        const from_nodes = this.max_seq_in_nodes();
        const next = Math.max(index.last_person_seq ?? 0, from_nodes) + 1;
        if (this.nodes().some((node)=>node.id === `p${next}`)) {
            throw new Error(`知识图谱 id 冲突：p${next} 已存在。拒绝写入以免边指向错误的人。`);
        }
        this.save_index({
            ...index,
            last_person_seq: next
        });
        return `p${next}`;
    }
    max_seq_in_nodes() {
        let max = 0;
        for (const node of this.nodes()){
            const match = /^p(\d+)$/.exec(node.id);
            if (match !== null) max = Math.max(max, Number(match[1]));
        }
        return max;
    }
    load_index() {
        const path = this.index_path();
        if (!existsSync(path)) return {};
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            return parsed;
        } catch  {
            const recovered = this.max_seq_in_nodes();
            probe('graph', 'index.corrupt_recovered', {
                recovered_seq: recovered
            });
            return {
                last_person_seq: recovered
            };
        }
    }
    save_index(index) {
        this.write_atomic(this.index_path(), `${JSON.stringify({
            ...index,
            updated_at: Date.now()
        }, null, 2)}\n`);
    }
    write_nodes(nodes) {
        this.write_atomic(this.nodes_path(), `${nodes.map((node)=>JSON.stringify(strip_undefined(node))).join('\n')}\n`);
        this.regenerate_view();
    }
    write_edges(edges) {
        this.write_atomic(this.edges_path(), `${edges.map((edge)=>JSON.stringify(strip_undefined(edge))).join('\n')}\n`);
        this.regenerate_view();
    }
    write_atomic(path, content) {
        mkdirSync(this.dir, {
            recursive: true
        });
        this.tmp_seq += 1;
        const tmp = `${path}.tmp-${process.pid}-${this.tmp_seq}`;
        writeFileSync(tmp, content, 'utf8');
        rename_with_retry(tmp, path);
    }
}
function read_jsonl(path) {
    if (!existsSync(path)) return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')){
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
            out.push(JSON.parse(trimmed));
        } catch  {
            probe('graph', 'jsonl.bad_line', {
                path
            });
        }
    }
    return out;
}
function today() {
    const now = new Date();
    const pad = (value)=>String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function normalize(value) {
    return value.trim().toLowerCase().replace(/\s+/g, '');
}
function age_from_birthday(birthday) {
    if (birthday === undefined) return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday.trim());
    if (match === null) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const now = new Date();
    let age = now.getFullYear() - year;
    const before_birthday = now.getMonth() + 1 < month || now.getMonth() + 1 === month && now.getDate() < day;
    if (before_birthday) age -= 1;
    return age >= 0 && age < 150 ? age : undefined;
}
function merge_list(existing, added) {
    const out = [];
    for (const item of [
        ...existing ?? [],
        ...added ?? []
    ]){
        const value = item.trim();
        if (value !== '' && !out.includes(value)) out.push(value);
    }
    return out.length === 0 ? undefined : out;
}
function merge_dates(existing, added) {
    const map = new Map();
    for (const item of existing ?? [])map.set(item.label, item.date);
    for (const item of added ?? [])map.set(item.label, item.date);
    return map.size === 0 ? undefined : [
        ...map
    ].map(([label, date])=>({
            label,
            date
        }));
}
function merge_evidence(existing, added) {
    if (added === undefined) return existing === undefined ? undefined : [
        ...existing
    ];
    const out = [
        ...existing ?? []
    ];
    if (!out.some((item)=>item.date === added.date && item.note === added.note)) out.push(added);
    return out.slice(-12);
}
function build_path(hops, nodes) {
    const name = (id)=>nodes.get(id)?.name ?? id;
    const node_ids = [
        hops[0].from,
        ...hops.map((edge)=>edge.to)
    ];
    const readable = hops.map((edge)=>`${name(edge.from)}的${edge.label}是${name(edge.to)}`).join('，');
    return {
        node_ids,
        names: node_ids.map(name),
        hops: hops.map((edge)=>({
                from: name(edge.from),
                to: name(edge.to),
                label: edge.label
            })),
        readable
    };
}
function strip_undefined(value) {
    const out = {};
    for (const [key, item] of Object.entries(value)){
        if (item !== undefined) out[key] = item;
    }
    return out;
}
