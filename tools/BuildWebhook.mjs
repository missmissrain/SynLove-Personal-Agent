/**
 * 增量编译连接器：使用现有 Node 内置 TypeScript 转换，不安装依赖。
 * 参数：命令行传入 webhook 子包名；默认只构建微信与 QQ。保留现有类型声明。
 */
import { stripTypeScriptTypes } from 'node:module'
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

class BuildWebhook {
  /** name 为 webhook 内已存在包名；只转换该包 src 内的 TypeScript 文件。 */
  build_package(name) {
    if (!['webhook-weixin','webhook-qq','tool-opencode','tool-codex'].includes(name)) throw Error('未知构建包')
    const root = join(dirname(dirname(fileURLToPath(import.meta.url))), 'backend/packages/webhook', name)
    this.build_tree(join(root, 'src'), join(root, 'lib/types'))
    writeFileSync(join(root, 'lib/index.js'), "export * from './types/index.js'\n")
    console.log(`已构建 ${name}`)
  }
  /** source、target 为源与产物目录；递归镜像转换，输出导入统一指向 .js。 */
  build_tree(source, target) {
    mkdirSync(target, { recursive: true })
    for (const item of readdirSync(source, { withFileTypes: true })) {
      if (item.isDirectory()) this.build_tree(join(source,item.name), join(target,item.name))
      else if (item.name.endsWith('.ts') && !item.name.endsWith('.d.ts')) {
        const code = stripTypeScriptTypes(readFileSync(join(source,item.name), 'utf8'), { mode:'transform' })
          .replace(/(['"])([^'"\n]+)\.ts\1/g, '$1$2.js$1')
        writeFileSync(join(target,item.name.replace(/\.ts$/,'.js')), code)
      }
    }
  }
}
const builder = new BuildWebhook()
const names=process.argv.slice(2).filter(name=>!name.startsWith('--'))
for (const name of names.length ? names : ['webhook-weixin','webhook-qq'])
  builder.build_package(name)
