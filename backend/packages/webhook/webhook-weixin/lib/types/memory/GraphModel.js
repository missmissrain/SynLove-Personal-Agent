import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { probe } from '../diagnostics/probe.js';
export class GraphModel {
    get_llm;
    get_model;
    timeout_ms;
    constructor(get_llm, get_model, timeout_ms = 300_000){
        this.get_llm = get_llm;
        this.get_model = get_model;
        this.timeout_ms = timeout_ms;
    }
    async complete(prompt) {
        const route = this.get_model();
        const llm = this.get_llm();
        if (!llm || !route.provider || !route.model) throw Error('图谱主模型未配置或尚未就绪');
        const signal = AbortSignal.timeout(this.timeout_ms);
        const blocks = new BlockAssembler();
        let finished = false;
        for await (const chunk of llm.stream({
            ...route,
            maxTokens: 4096,
            signal,
            messages: [
                createUserMessage({
                    content: [
                        {
                            type: 'text',
                            text: prompt
                        }
                    ],
                    source: {
                        kind: 'plugin',
                        plugin: 'synlove-graph'
                    }
                })
            ]
        })){
            signal.throwIfAborted();
            blocks.push(chunk);
            if (chunk.type === 'finish') {
                finished = true;
                if (chunk.reason.kind !== 'stop') throw Error(`图谱主模型未正常完成：${chunk.reason.kind}`);
            }
        }
        signal.throwIfAborted();
        const text = blocks.blocks().filter((block)=>block.type === 'text').map((block)=>block.text).join('');
        if (!finished || !text.trim()) throw Error('图谱主模型没有返回完整正文');
        probe('graph', 'model.completed', {
            ...route,
            usage: blocks.usage
        });
        return text;
    }
}
