const ATTRIBUTE_FIELDS = {
    姓名: 'name',
    别名: 'aliases',
    出生日期: 'birthday',
    生日: 'birthday',
    年龄: 'age',
    性别: 'gender',
    状态: 'status',
    联系方式: 'contacts',
    电话: 'contacts',
    所在地: 'location',
    职业: 'occupation',
    家庭情况: 'family_summary',
    重要日期: 'important_dates',
    备注: 'notes'
};
export function map_attribute_field(field) {
    const key = field.trim();
    return ATTRIBUTE_FIELDS[key] ?? key;
}
export function is_known_attribute_field(field) {
    return ATTRIBUTE_FIELDS[field.trim()] !== undefined;
}
export function parse_facts(text) {
    const facts = [];
    const bad_lines = [];
    for (const raw of text.split('\n')){
        const line = raw.trim().replace(/^[-*]\s*/, '');
        if (line === '' || line === '无' || line.startsWith('#')) continue;
        const parts = line.split('|').map((item)=>item.trim());
        const at = (index)=>parts[index] ?? '';
        const tag = at(0);
        switch(tag){
            case '人物':
                {
                    if (at(1) === '') {
                        bad_lines.push(line);
                        break;
                    }
                    const aliases = at(2).split(/[,，、]/).map((item)=>item.trim()).filter((item)=>item !== '');
                    facts.push({
                        kind: 'person',
                        name: at(1),
                        ...aliases.length === 0 ? {} : {
                            aliases
                        }
                    });
                    break;
                }
            case '属性':
                {
                    if (at(1) === '' || at(2) === '' || at(3) === '') {
                        bad_lines.push(line);
                        break;
                    }
                    facts.push({
                        kind: 'attribute',
                        name: at(1),
                        field: at(2),
                        value: at(3)
                    });
                    break;
                }
            case '关系':
                {
                    if (at(1) === '' || at(2) === '' || at(3) === '') {
                        bad_lines.push(line);
                        break;
                    }
                    facts.push({
                        kind: 'relation',
                        from: at(1),
                        to: at(2),
                        label: at(3)
                    });
                    break;
                }
            case '事件':
                {
                    if (at(1) === '' || at(3) === '') {
                        bad_lines.push(line);
                        break;
                    }
                    facts.push({
                        kind: 'event',
                        name: at(1),
                        date: at(2),
                        description: at(3)
                    });
                    break;
                }
            case '未绑定':
                {
                    if (at(1) === '') {
                        bad_lines.push(line);
                        break;
                    }
                    facts.push({
                        kind: 'unresolved',
                        reference: at(1),
                        quote: at(3) === '' ? at(2) : at(3)
                    });
                    break;
                }
            case '上文':
                {
                    const text = parts.slice(1).join('|').trim();
                    if (text === '') {
                        bad_lines.push(line);
                        break;
                    }
                    facts.push({
                        kind: 'gist',
                        text
                    });
                    break;
                }
            default:
                bad_lines.push(line);
        }
    }
    return {
        facts,
        bad_lines
    };
}
export function render_candidates(people, limit = 30) {
    const unique = [];
    for (const item of people){
        const value = item.trim();
        if (value !== '' && !unique.includes(value)) unique.push(value);
    }
    if (unique.length === 0) return '（暂无已知人物）';
    return unique.slice(-limit).join('、');
}
export function render_pending(pending, limit = 5) {
    if (pending.length === 0) return '';
    return pending.slice(-limit).map((item)=>`- "${item.reference}" → 可能指：${item.quote}`).join('\n');
}
