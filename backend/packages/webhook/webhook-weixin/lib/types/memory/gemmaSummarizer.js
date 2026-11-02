import { probe } from '../diagnostics/probe.js';
const INSTRUCTIONS = [
    '【角色】你是长期记忆整理器。输入是某一天"用户"与"助手"的对话记录。',
    '【输出格式】',
    '- 中文，最多 6 条，每条一行，以 "- " 开头',
    '- 每行以类别开头，类别只能是：事实 / 待办 / 偏好',
    '- 只输出这些行，不要标题、前言、结语、解释',
    '【完成标记的唯一判据】',
    'A. 只有"记录里明确说了这件事已经做完"才能标"（已完成）"：助手的完成声明（改好了/已发出/测试通过/已关闭），或用户的完成声明（已经交了/已经弄完了/不用了）。',
    'B. "设置提醒""安排时间""约定日期""记下来"一律**不是**完成，必须写成待办。',
    'C. 未完成的、正在进行中的、未来的事情，一律**不得**出现"（已完成）"三个字。',
    '【逐行规则】',
    '1. 已完成的事项写成："- 事实：<事项>（已完成）"；完成标记**只允许出现在 事实 行**。',
    '2. 待办写成："- 待办：<事项>（<时间，若有>）"，待办行**禁止**出现任何完成字样。',
    '3. 偏好写成："- 偏好：<内容>"；用户发来的图片若写了内容描述，可写成 "- 事实：用户发来一张照片（<描述要点>）"。',
    '4. 每条必须能对应到记录原话；对应不上就不写。禁止推断、补常识、评价、编造。',
    '5. 时间口径保留记录原话；记录未给具体日期时不要自己换算。',
    '6. 不写寒暄、情绪、客套话。'
].join('\n');
function render_entries(entries) {
    return entries.map((item)=>{
        const head = `[${item.role === 'user' ? '用户' : '助手'}] ${item.text.trim()}`;
        const media = (item.attachments ?? []).map((attach)=>`  [图片${attach.name === undefined ? '' : ' ' + attach.name}] ${attach.description ?? '(无描述)'}`).join('\n');
        return media === '' ? head : `${head}\n${media}`;
    }).join('\n');
}
function chunk_entries(entries, budget) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const item of entries){
        const cost = item.text.length + 16;
        if (current.length > 0 && size + cost > budget) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(item);
        size += cost;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}
export function create_gemma_summarizer(options) {
    const base_url = (options?.base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
    const model = options?.model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M';
    const max_tokens = options?.max_tokens ?? 600;
    const timeout_ms = options?.timeout_ms ?? Number(process.env.SYNLOVE_LLM_TIMEOUT_MS ?? '300000');
    const chunk_chars = options?.chunk_chars ?? 24_000;
    const fetch_impl = options?.fetch_impl ?? fetch;
    const complete = options?.complete ?? (async (prompt, tokens)=>{
        const controller = new AbortController();
        const timer = setTimeout(()=>controller.abort(), timeout_ms);
        try {
            const response = await fetch_impl(`${base_url}/chat/completions`, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'Content-Type': 'application/json',
                    ...process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY'] ? {
                        Authorization: `Bearer ${process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY']}`
                    } : {}
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.3,
                    max_tokens: tokens,
                    stream: false
                }),
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`gemma HTTP ${response.status}`);
            const parsed = await response.json();
            const text = parsed.choices?.[0]?.message?.content ?? '';
            probe('timeline', 'gemma.completion', {
                model,
                prompt_tokens: parsed.usage?.prompt_tokens,
                completion_tokens: parsed.usage?.completion_tokens
            });
            return text.trim();
        } finally{
            clearTimeout(timer);
        }
    });
    return async (request)=>{
        const rendered = render_entries(request.entries);
        const previous = '';
        if (rendered.length <= chunk_chars) {
            const text = await complete(`${INSTRUCTIONS}${previous}\n\n【数据】\n日期：${request.date}\n对话记录：\n${rendered}`, max_tokens);
            return {
                text,
                model
            };
        }
        const chunks = chunk_entries(request.entries, chunk_chars);
        probe('timeline', 'gemma.map_reduce', {
            date: request.date,
            chunks: chunks.length,
            chars: rendered.length
        });
        const partials = [];
        for (const [index, chunk] of chunks.entries()){
            const text = await complete(`${INSTRUCTIONS}\n\n【数据】\n这是当天第 ${index + 1}/${chunks.length} 段记录，请只整理这一段：\n${render_entries(chunk)}`, 300);
            partials.push(`【第 ${index + 1} 段】\n${text}`);
        }
        const merged = await complete(`${INSTRUCTIONS}${previous}\n\n【数据】\n下面是同一天各段的小结，请合并成一份当天摘要（格式同上，不要照抄段落编号）：\n\n${partials.join('\n\n')}`, max_tokens);
        return {
            text: merged,
            model
        };
    };
}
export function create_gemma_image_describer(options) {
    const base_url = (options?.base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
    const model = options?.model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M';
    const timeout_ms = options?.timeout_ms ?? Number(process.env.SYNLOVE_LLM_TIMEOUT_MS ?? '300000');
    const instruction = options?.instruction ?? '用一句中文描述这张图片的主要内容（谁/什么、在哪、在做什么、明显的文字）。只输出这一句话，不要评价，不要客套。';
    const fetch_impl = options?.fetch_impl ?? fetch;
    return async (input)=>{
        const controller = new AbortController();
        const timer = setTimeout(()=>controller.abort(), timeout_ms);
        try {
            const response = await fetch_impl(`${base_url}/chat/completions`, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'Content-Type': 'application/json',
                    ...process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY'] ? {
                        Authorization: `Bearer ${process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY']}`
                    } : {}
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: instruction
                                },
                                {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:${input.media_type};base64,${Buffer.from(input.data).toString('base64')}`
                                    }
                                }
                            ]
                        }
                    ],
                    temperature: 0.2,
                    max_tokens: 200,
                    stream: false
                }),
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`gemma vision HTTP ${response.status}`);
            const parsed = await response.json();
            const text = (parsed.choices?.[0]?.message?.content ?? '').trim();
            probe('timeline', 'gemma.image_described', {
                model,
                chars: text.length
            });
            return text;
        } finally{
            clearTimeout(timer);
        }
    };
}
export function undescribed_attachments(attachments) {
    return (attachments ?? []).filter((item)=>item.description === undefined);
}
