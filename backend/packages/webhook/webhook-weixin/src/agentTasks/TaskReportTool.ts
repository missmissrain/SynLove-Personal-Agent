/**
 * 受限报告工具：执行者只能保存本任务报告，不获得任意文件写入或命令权限。
 * 注册参数 root 为生产目录、id 为宿主任务标识；默认输出完整 Markdown 报告。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TaskReportStore } from './TaskReportStore.ts'

export class TaskReportTool {
  /** root、id 均由任务工厂绑定，不能由模型修改。 */
  constructor(private root: string, private id: string) {}
  /** ctx 为执行者作用域；注册仅写入当前任务固定产物的工具。 */
  mount_tool(ctx: any): void {
    const store = new TaskReportStore(this.root), id = this.id
    ctx.tools.register(defineTool({
      name: 'save_report',
      description: '保存本任务完整报告到宿主固定产物目录。只传正文，不传文件路径；成功后最终总结简短说明结论、限制和返回的真实路径。',
      parameters: { content: { type: 'string', required: true, description: '完整 Markdown 报告正文，包含来源、数字与未验证项。' } },
      output: {
        schema: { type: 'object', additionalProperties:false, properties: { path: { type: 'string', required: true }, characters: { type: 'number', required: true } } },
        render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      /** args.content 为报告正文；只保存当前绑定任务，不接受路径参数。 */
      async execute(args: any) { return store.save_report(id, args.content) },
    }))
  }
}
