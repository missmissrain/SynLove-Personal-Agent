import { probe } from '../diagnostics/probe.js';
import { is_known_attribute_field, map_attribute_field, parse_facts, render_candidates, render_pending } from './graphProtocol.js';
import { GRAPH_ASSISTANT_NAME, GRAPH_USER_NAME } from './graphTypes.js';
const SELF_ALIASES = [
    '我',
    '用户',
    '主人',
    '本人',
    '自己'
];
const ASSISTANT_ALIASES = [
    '欣爱',
    '助手',
    '小爱',
    '你'
];
export function canonical_person_name(name) {
    const value = name.trim();
    if (SELF_ALIASES.includes(value)) return GRAPH_USER_NAME;
    if (ASSISTANT_ALIASES.includes(value)) return GRAPH_ASSISTANT_NAME;
    return value;
}
const EXTRACT_RULES = [
    '你在把聊天记录整理成"人物事实"，用于维护一份家人/朋友关系图。',
    '',
    '【输出格式】每行一条，各欄用竖线分隔。行首标签只允许这几种：',
    '第一种是"人物"，后面依次跟：人名、别名（多个用逗号隔开，没有就留空）。',
    '第二种是"属性"，后面依次跟：人名、字段名、值。',
    '第三种是"关系"，后面依次跟：称呼者、被称呼者、称呼。',
    '第四种是"事件"，后面依次跟：人名、日期、描述。',
    '第五种是"未绑定"，后面依次跟：指代词、原文片段。',
    '第六种是"上文"，后面跟一句话，概括这一块里与人物有关的要点（供下一块判断指代用）。',
    '（不要把上面这些说明当成内容抄下来；只输出真实提取到的行。）',
    '没有内容就输出：无',
    '',
    '【字段名只能用这些】姓名/别名/出生日期/年龄/性别/状态/联系方式/所在地/职业/家庭情况/重要日期/备注',
    '',
    '【硬性规则】',
    '0. 这张图以"欣爱"为中心。记录里的两个说话人已经有名字，直接用：',
    '   "[主人]"是主人本人（图谱里的规范名就是"主人"），"[欣爱]"是你自己（规范名"欣爱"）。',
    '   凡是没有指明"谁在称呼"的亲属关系，都是主人的关系，称呼者一律写"主人"。',
    '0.1 "主人"只是**称呼**，不是主人的姓名——**他的姓名还不知道**。',
    '   除非记录里明确说出姓名（"我叫张三"），否则不要写 属性|主人|姓名|…，也不要猜。',
    '   如果记录里说了以后怎么称呼（"以后叫我老板"），写成：关系|欣爱|主人|老板。',
    '1. 只写记录里明确出现的信息。禁止推断、禁止补常识、禁止编造。',
    '1.1 "用户""助手"这类词是说话人标记，**不是人名**，绝不要写成 人物 行，也不要据此编造职业/身份。',
    '2. "关系"的方向是**称呼者怎么称呼被称呼者**：记录里说"我妈王丽"，就写：关系|主人|王丽|妈妈。',
    '3. 指代词（他/她/那个人/之前那个/我同事）**必须换成名单里的具体姓名**才能写成 人物/属性/关系。',
    '   换不出来就写 未绑定|指代词|原文片段，不要猜。',
    '4. 不要把寒暄、情绪、语气词写成事实。',
    '5. 不确定的宁可不写。'
].join('\n');
const MERGE_RULES = [
    '你在压缩一份"人物事实"的上下文，压缩后会继续用来处理后面的聊天记录。',
    '输入有三部分：旧的上下文提要、旧的事实清单、新的一段聊天记录。',
    '',
    '【输出格式】每行一条，用竖线分隔：',
    '提要行：行首写"上文"，后面跟一句话概括要点（最多 10 行；务必保留还没解开的指代）。',
    '事实行：行首写"属性"或"关系"或"人物"，后面按原来的字段顺序跟内容（去重，最多 60 行）。',
    '',
    '【硬性规则】',
    '1. **事实不能因为压缩而丢**：人名、称呼、关键属性必须保留下来。',
    '2. 新旧冲突时以新记录为准。',
    '3. 只输出上面两种行，不要解释、不要前言后语。'
].join('\n');
const REVIEW_RULES = [
    '你在审核一个人物档案要不要更新。',
    '',
    '【输出格式】每行一条，只允许：',
    '更新|字段|值',
    '没有需要更新就输出：无',
    '',
    '【硬性规则】',
    '1. 只能根据下面给出的"本次事实"来更新，不能凭印象补充。',
    '2. 字段名只能用：姓名/别名/出生日期/年龄/性别/状态/联系方式/所在地/职业/家庭情况/重要日期/备注。',
    '3. 事实与现有档案冲突时，以本次事实为准并更新；没有提到的字段不要动。',
    '4. 不确定就不输出。'
].join('\n');
const NEW_PERSON_RULES = [
    '你在决定要不要给关系图添加**新人物**。',
    '',
    '【输出格式】每行一条，只允许：',
    '人物|姓名|别名1,别名2',
    '关系|称呼者|被称呼者|称呼',
    '没有新人物就输出：无',
    '',
    '【硬性规则】',
    '1. 名单里已经有的人**不要**再输出 人物 行。',
    '2. 只添加记录里明确出现、且有名字的人。指代词换不出姓名的不要添加。',
    '3. 关系行的方向是"称呼者怎么称呼被称呼者"。',
    '4. 不确定就不输出。'
].join('\n');
export async function update_graph_from_records(options, records) {
    const graph = options.graph;
    const chunk_chars = options.chunk_chars ?? Number(process.env.DSH_GRAPH_CHUNK_CHARS ?? '8000');
    const max_prompt_chars = options.max_prompt_chars ?? Number(process.env.DSH_GRAPH_MAX_PROMPT_CHARS ?? '30000');
    await graph.ensure_center();
    const chunks = chunk_records(records, chunk_chars);
    const all_facts = [];
    let bad_lines = 0;
    let unresolved_total = 0;
    let unresolved = [];
    const gists = [];
    const facts_carried = [];
    let trimmed_prompts = 0;
    let merged_count = 0;
    for (const [index, chunk] of chunks.entries()){
        const date = chunk[chunk.length - 1]?.date ?? '';
        const build = async (gist_list, fact_list)=>[
                EXTRACT_RULES,
                '',
                '【已知人物名单（指代词只能从中选择，或用 未绑定）】',
                render_candidates(await candidate_names(graph)),
                ...carry_section(gist_list, fact_list, unresolved),
                ...tail_of(records, chunk, 4) === '' ? [] : [
                    '',
                    '【本块之前的几句（帮助判断指代）】',
                    tail_of(records, chunk, 4)
                ],
                '',
                '【本块聊天记录】',
                chunk.map((item)=>format_line(item)).join('\n')
            ].join('\n');
        let prompt = await build(gists, facts_carried);
        if (prompt.length > max_prompt_chars && (gists.length > 0 || facts_carried.length > 0)) {
            const merge_prompt = build_merge(gists, facts_carried, chunk);
            if (merge_prompt.length <= max_prompt_chars) {
                const merged = parse_facts(await options.complete(merge_prompt));
                bad_lines += merged.bad_lines.length;
                gists.length = 0;
                facts_carried.length = 0;
                for (const fact of merged.facts){
                    if (fact.kind === 'unresolved') {
                        unresolved.push({
                            reference: fact.reference,
                            quote: fact.quote
                        });
                        unresolved_total += 1;
                        continue;
                    }
                    if (fact.kind === 'gist') {
                        gists.push(fact.text);
                        continue;
                    }
                    const canonical = canonicalize_fact(fact);
                    all_facts.push({
                        fact: canonical,
                        date,
                        quote: quote_of(canonical)
                    });
                    facts_carried.push(render_fact(canonical));
                }
                merged_count += 1;
                probe('graph', 'update.merged', {
                    index: index + 1,
                    gists: gists.length,
                    facts: facts_carried.length,
                    prompt_chars: merge_prompt.length
                });
                continue;
            }
            let gist_list = [
                ...gists
            ];
            let fact_list = [
                ...facts_carried
            ];
            while(merge_prompt.length > max_prompt_chars && (gist_list.length > 0 || fact_list.length > 0)){
                if (gist_list.length > 0) gist_list = gist_list.slice(1);
                else fact_list = fact_list.slice(1);
                trimmed_prompts += 1;
                break;
            }
            gists.length = 0;
            gists.push(...gist_list);
            facts_carried.length = 0;
            facts_carried.push(...fact_list);
            prompt = await build(gists, facts_carried);
        }
        const parsed = parse_facts(await options.complete(prompt));
        bad_lines += parsed.bad_lines.length;
        unresolved = [];
        for (const fact of parsed.facts){
            if (fact.kind === 'unresolved') {
                unresolved.push({
                    reference: fact.reference,
                    quote: fact.quote
                });
                unresolved_total += 1;
                continue;
            }
            if (fact.kind === 'gist') {
                gists.push(fact.text);
                continue;
            }
            const canonical = canonicalize_fact(fact);
            all_facts.push({
                fact: canonical,
                date,
                quote: quote_of(canonical)
            });
            facts_carried.push(render_fact(canonical));
        }
        probe('graph', 'update.chunk_done', {
            index: index + 1,
            chunks: chunks.length,
            facts: parsed.facts.length,
            bad: parsed.bad_lines.length,
            prompt_chars: prompt.length,
            trimmed: trimmed_prompts
        });
    }
    const created = [];
    const touched = new Set();
    for (const item of all_facts){
        switch(item.fact.kind){
            case 'person':
                {
                    const existed = await graph.find(item.fact.name) !== undefined;
                    await graph.upsert_person({
                        name: item.fact.name,
                        ...item.fact.aliases === undefined ? {} : {
                            aliases: item.fact.aliases
                        },
                        evidence: {
                            date: item.date,
                            note: item.quote
                        }
                    });
                    if (!existed) created.push(item.fact.name);
                    touched.add(item.fact.name);
                    break;
                }
            case 'attribute':
                touched.add(item.fact.name);
                break;
            case 'relation':
                touched.add(item.fact.from);
                touched.add(item.fact.to);
                break;
            default:
                break;
        }
    }
    const to_review = options.full_scan === true ? (await graph.nodes()).map((node)=>node.name) : [
        ...touched
    ];
    const updated = [];
    for (const name of to_review){
        const node = await graph.find(name);
        if (node === undefined) continue;
        const related = all_facts.filter((item)=>item.fact.kind === 'attribute' && item.fact.name === name || item.fact.kind === 'person' && item.fact.name === name);
        if (related.length === 0 && options.full_scan !== true) continue;
        const prompt = [
            REVIEW_RULES,
            '',
            `【人物】${node.name}`,
            `【现有档案】${describe_current(node)}`,
            '',
            '【本次事实】',
            related.length === 0 ? '（无）' : related.map((item)=>render_fact(item.fact)).join('\n')
        ].join('\n');
        const parsed = parse_facts_review(await options.complete(prompt));
        bad_lines += parsed.bad_lines.length;
        if (parsed.updates.length === 0) continue;
        const patch = patch_from_updates(parsed.updates);
        if (Object.keys(patch).length === 0) continue;
        await graph.upsert_person({
            id: node.id,
            name: node.name,
            ...patch,
            evidence: {
                date: all_facts[0]?.date ?? '',
                note: '逐节点审核'
            }
        });
        updated.push(node.name);
        probe('graph', 'update.node_reviewed', {
            name: node.name,
            fields: Object.keys(patch).length
        });
    }
    for (const item of all_facts){
        if (item.fact.kind !== 'attribute') continue;
        const patch = patch_from_updates([
            {
                field: item.fact.field,
                value: item.fact.value
            }
        ]);
        if (Object.keys(patch).length === 0) continue;
        const existing = await graph.find(item.fact.name);
        await graph.upsert_person({
            name: item.fact.name,
            ...patch,
            ...existing !== undefined && typeof patch.name === 'string' ? {
                id: existing.id
            } : {},
            evidence: {
                date: item.date,
                note: item.quote
            }
        });
        touched.add(item.fact.name);
    }
    let relations_created = 0;
    for (const item of all_facts){
        if (item.fact.kind !== 'relation') continue;
        const edge = await graph.upsert_edge({
            from: item.fact.from,
            to: item.fact.to,
            label: item.fact.label,
            ...is_address_pair(item.fact.from, item.fact.to) ? {
                kind: 'address'
            } : {},
            evidence: {
                date: item.date,
                note: item.quote
            }
        });
        if (edge !== undefined) relations_created += 1;
    }
    const known = await candidate_names(graph);
    const fact_lines = all_facts.map((item)=>render_fact(item.fact));
    const build_new = (lines)=>[
            NEW_PERSON_RULES,
            '',
            '【已知人物名单】',
            render_candidates(known, 60),
            '',
            '【本次整理出的事实】',
            lines.length === 0 ? '（无）' : lines.join('\n')
        ].join('\n');
    let kept = fact_lines;
    let new_prompt = build_new(kept);
    while(new_prompt.length > max_prompt_chars && kept.length > 0){
        kept = kept.slice(1);
        new_prompt = build_new(kept);
        trimmed_prompts += 1;
    }
    const new_parsed = parse_facts(await options.complete(new_prompt));
    bad_lines += new_parsed.bad_lines.length;
    for (const fact of new_parsed.facts){
        if (fact.kind === 'person' && await graph.find(fact.name) === undefined) {
            await graph.upsert_person({
                name: fact.name,
                ...fact.aliases === undefined ? {} : {
                    aliases: fact.aliases
                },
                evidence: {
                    date: all_facts[0]?.date ?? '',
                    note: '新增人物审核'
                }
            });
            created.push(fact.name);
        }
        if (fact.kind === 'relation') {
            const edge = await graph.upsert_edge({
                from: fact.from,
                to: fact.to,
                label: fact.label,
                evidence: {
                    date: all_facts[0]?.date ?? '',
                    note: '新增人物审核'
                }
            });
            if (edge !== undefined) relations_created += 1;
        }
    }
    const result = {
        chunks: chunks.length,
        facts: all_facts.length,
        bad_lines,
        people_created: created,
        people_updated: updated,
        relations_created,
        unresolved: unresolved_total,
        merged_blocks: merged_count,
        trimmed_prompts
    };
    probe('graph', 'update.done', {
        ...result
    });
    return result;
}
function build_merge(gists, facts, chunk) {
    return [
        MERGE_RULES,
        '',
        '【旧的上下文提要】',
        gists.length === 0 ? '（无）' : gists.map((item)=>`- ${item}`).join('\n'),
        '',
        '【旧的事实清单】',
        facts.length === 0 ? '（无）' : facts.join('\n'),
        '',
        '【新的一段聊天记录】',
        chunk.map((item)=>format_line(item)).join('\n')
    ].join('\n');
}
function carry_section(gists, facts, unresolved) {
    const out = [];
    if (gists.length > 0) {
        out.push('', '【前文提要（前面几块的压缩要点，帮助判断指代）】');
        for (const gist of gists.slice(-8))out.push(`- ${gist}`);
    }
    if (facts.length > 0) {
        out.push('', '【前面已提取的事实（不要重复输出这些）】');
        for (const fact of facts.slice(-40))out.push(fact);
    }
    if (unresolved.length > 0) {
        out.push('', '【前面未解开的指代】', render_pending(unresolved));
    }
    return out;
}
function is_address_pair(from, to) {
    const centers = [
        GRAPH_ASSISTANT_NAME,
        GRAPH_USER_NAME
    ];
    return from !== to && centers.includes(from) && centers.includes(to);
}
async function candidate_names(graph) {
    const out = [];
    for (const node of (await graph.nodes())){
        out.push(node.name);
        for (const alias of node.aliases ?? [])out.push(alias);
    }
    return out;
}
function chunk_records(records, budget) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const record of records){
        const cost = record.text.length + 8;
        if (current.length > 0 && size + cost > budget) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(record);
        size += cost;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}
function tail_of(records, chunk, lines) {
    const first = records.indexOf(chunk[0]);
    if (first <= 0) return '';
    return records.slice(Math.max(0, first - lines), first).map((item)=>format_line(item)).join('\n');
}
function format_line(item) {
    const speaker = item.role === 'user' ? GRAPH_USER_NAME : GRAPH_ASSISTANT_NAME;
    return `[${speaker}] ${item.text}`;
}
function canonicalize_fact(fact) {
    switch(fact.kind){
        case 'person':
            return {
                ...fact,
                name: canonical_person_name(fact.name)
            };
        case 'attribute':
            return {
                ...fact,
                name: canonical_person_name(fact.name)
            };
        case 'relation':
            return {
                ...fact,
                from: canonical_person_name(fact.from),
                to: canonical_person_name(fact.to)
            };
        case 'event':
            return {
                ...fact,
                name: canonical_person_name(fact.name)
            };
        default:
            return fact;
    }
}
function render_fact(fact) {
    switch(fact.kind){
        case 'person':
            return `人物|${fact.name}${fact.aliases === undefined ? '' : '|' + fact.aliases.join(',')}`;
        case 'attribute':
            return `属性|${fact.name}|${fact.field}|${fact.value}`;
        case 'relation':
            return `关系|${fact.from}|${fact.to}|${fact.label}`;
        case 'event':
            return `事件|${fact.name}|${fact.date}|${fact.description}`;
        case 'unresolved':
            return `未绑定|${fact.reference}|${fact.quote}`;
        case 'gist':
            return `上文|${fact.text}`;
    }
}
function quote_of(fact) {
    return render_fact(fact).slice(0, 80);
}
function describe_current(node) {
    const bits = [];
    if (node.aliases !== undefined && node.aliases.length > 0) bits.push(`别名=${node.aliases.join(',')}`);
    if (node.birthday !== undefined) bits.push(`出生日期=${node.birthday}`);
    if (node.age !== undefined) bits.push(`年龄=${node.age}`);
    if (node.gender !== undefined) bits.push(`性别=${node.gender}`);
    if (node.status !== undefined) bits.push(`状态=${node.status}`);
    if (node.contacts !== undefined && node.contacts.length > 0) bits.push(`联系方式=${node.contacts.join(',')}`);
    if (node.location !== undefined) bits.push(`所在地=${node.location}`);
    if (node.occupation !== undefined) bits.push(`职业=${node.occupation}`);
    if (node.family_summary !== undefined) bits.push(`家庭情况=${node.family_summary}`);
    if (node.notes !== undefined) bits.push(`备注=${node.notes}`);
    return bits.length === 0 ? '（空）' : bits.join('；');
}
function parse_facts_review(text) {
    const updates = [];
    const bad_lines = [];
    for (const raw of text.split('\n')){
        const line = raw.trim().replace(/^[-*]\s*/, '');
        if (line === '' || line === '无' || line.startsWith('#')) continue;
        const parts = line.split('|').map((item)=>item.trim());
        const field = parts[1] ?? '';
        if (parts[0] !== '更新' || field === '' || parts.length < 3) {
            bad_lines.push(line);
            continue;
        }
        updates.push({
            field,
            value: parts.slice(2).join('|')
        });
    }
    return {
        updates,
        bad_lines
    };
}
function patch_from_updates(updates) {
    const patch = {};
    for (const { field, value } of updates){
        if (!is_known_attribute_field(field)) continue;
        const key = map_attribute_field(field);
        switch(key){
            case 'age':
                {
                    const age = Number(value.replace(/[^\d]/g, ''));
                    if (Number.isFinite(age) && age > 0 && age < 150) patch.age = age;
                    break;
                }
            case 'contacts':
                patch.contacts = value.split(/[,，、;；]/).map((item)=>item.trim()).filter((item)=>item !== '');
                break;
            case 'aliases':
                patch.aliases = value.split(/[,，、;；]/).map((item)=>item.trim()).filter((item)=>item !== '');
                break;
            case 'status':
                patch.status = /已故|去世|过世/.test(value) ? 'deceased' : /失联|联系不上/.test(value) ? 'lost_contact' : /在世|健在/.test(value) ? 'alive' : 'unknown';
                break;
            case 'gender':
                patch.gender = /男/.test(value) ? 'male' : /女/.test(value) ? 'female' : 'unknown';
                break;
            case 'important_dates':
                {
                    const match = /^(.+?)\s*[:：]?\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/.exec(value.trim());
                    if (match !== null) patch.important_dates = [
                        {
                            label: match[1].trim(),
                            date: match[2]
                        }
                    ];
                    break;
                }
            default:
                if (value.trim() !== '') patch[key] = value.trim();
        }
    }
    return patch;
}
