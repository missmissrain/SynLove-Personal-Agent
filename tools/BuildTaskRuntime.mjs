/**
 * 任务模块构建器：用项目要求的Node 24内置TypeScript转换器生成任务模块运行文件。
 * 注册参数无；从固定src/agentTasks读取，仅生成同名lib/types/agentTasks，不安装新依赖。
 */
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

class TaskRuntimeBuilder {
  /** 无参数；定位当前仓库根目录，不依赖命令行工作目录。 */
  constructor() { this.root = resolve(dirname(fileURLToPath(import.meta.url)), '..') }
  /** 无参数；转换任务源码并重写本地.ts导入，产物保留源文件中文注释。 */
  build_runtime() {
    const base = join(this.root, 'backend/packages/webhook/webhook-weixin')
    let count = 0
    const selected = process.argv.slice(2)
    const files = readdirSync(join(base, 'src/agentTasks')).filter(file => !selected.length || selected.includes(file))
    for (const file of files) {
      if (!file.endsWith('.ts')) continue
      const input = readFileSync(join(base, 'src/agentTasks', file), 'utf8')
      const output = stripTypeScriptTypes(input, { mode: 'transform' })
        .replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2')
      writeFileSync(join(base, 'lib/types/agentTasks', file.replace(/\.ts$/, '.js')), output, 'utf8')
      count++
    }
    console.log(`任务运行模块已构建：${count} 个`)
  }
}
new TaskRuntimeBuilder().build_runtime()
