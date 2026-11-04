import { defineTool } from '@deepseek-ai/dsh-tools';
import { TaskReportStore } from './TaskReportStore.js';
export class TaskReportTool {
    root;
    id;
    constructor(root, id){
        this.root = root;
        this.id = id;
    }
    mount_tool(ctx) {
        const store = new TaskReportStore(this.root), id = this.id;
        ctx.tools.register(defineTool({
            name: 'save_report',
            description: '保存本任务完整报告到宿主固定产物目录。只传正文，不传文件路径；成功后最终总结简短说明结论、限制和返回的真实路径。',
            parameters: {
                content: {
                    type: 'string',
                    required: true,
                    description: '完整 Markdown 报告正文，包含来源、数字与未验证项。'
                }
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        path: {
                            type: 'string',
                            required: true
                        },
                        characters: {
                            type: 'number',
                            required: true
                        }
                    }
                },
                render: (_args, value)=>[
                        {
                            type: 'text',
                            text: JSON.stringify(value)
                        }
                    ]
            },
            async execute (args) {
                return store.save_report(id, args.content);
            }
        }));
    }
}
