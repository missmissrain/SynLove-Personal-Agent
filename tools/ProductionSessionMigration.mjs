/**
 * 会话路径迁移：在原始快照保留的前提下，将旧工作目录定位改为生产目录。
 * 默认参数：当前脚本上级为生产根；只处理停栈后的 runtime/dsh/sessions，不接触用户其他会话。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { sessionDir } from '../backend/packages/session/session-persistence-jsonl/lib/types/format.js'
import { scanZstdFrames, compressZstdFrame } from '../backend/packages/session/session-persistence-jsonl/lib/types/zstd.js'

export class ProductionSessionMigration {
  /** root 为生产根目录；原始代际文件移入本机迁移快照。 */
  constructor(root) {
    this.root = root
    this.sessions = path.join(root, 'runtime/dsh/sessions')
    this.base = path.resolve(root, '../..')
    this.backup = path.join(this.base, '备份/SynLove-v1.5-productionMigration/sessionLayout')
  }

  /** source 为完整多帧文件；只替换首帧中的 cwd，后续压缩帧逐字节保留。 */
  async rewrite_header(source) {
    const first = scanZstdFrames(source, 1).frames[0]
    if (!first) throw new Error('原始会话缺少完整头帧')
    const raw = zstdDecompressSync(source.subarray(first.start, first.end))
    const split = raw.indexOf(10)
    if (split < 0) throw new Error('原始头帧没有完整 JSON 行')
    const meta = JSON.parse(raw.subarray(0, split).toString())
    meta.cwd = this.root
    const header = await compressZstdFrame(Buffer.concat([
      Buffer.from(JSON.stringify(meta) + '\n'), raw.subarray(split + 1),
    ]))
    const encoded = Buffer.concat([header, source.subarray(first.end)])
    if (!encoded.subarray(header.length).equals(source.subarray(first.end))) {
      throw new Error('后续事件压缩帧不一致')
    }
    return encoded
  }

  /** 无参数；从原始归档重建首轮迁移副本，仅允许覆盖没有任何后续事件帧的目标。 */
  async repair_from_snapshot() {
    let count = 0
    let eventBytes = 0
    for (const project of await fs.readdir(this.backup, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const dir = path.join(this.backup, project.name)
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (!item.isDirectory()) continue
        const source = path.join(dir, item.name)
        const files = (await fs.readdir(source)).filter(n => /^session(?:\.v\d+)?\.jsonl\.zstd$/.test(n))
        for (const name of files) {
          const original = await fs.readFile(path.join(source, name))
          const first = scanZstdFrames(original, 1).frames[0]
          const meta = JSON.parse(zstdDecompressSync(original.subarray(0, first.end)).toString().split('\n')[0])
          const target = path.join(sessionDir(this.sessions, this.root, meta.id), name)
          const existing = await fs.readFile(target)
          const currentFirst = scanZstdFrames(existing, 1).frames[0]
          if (existing.length !== currentFirst.end) throw new Error('迁移目标已有事件，禁止覆盖')
          const previous = path.join(this.base, '备份/SynLove-v1.5-productionMigration/migrationRepairPrevious',
            path.relative(this.sessions, target))
          await fs.mkdir(path.dirname(previous), { recursive: true })
          await fs.copyFile(target, previous)
          const repaired = await this.rewrite_header(original)
          await fs.writeFile(target, repaired)
          eventBytes += original.length - first.end
          count++
        }
      }
    }
    console.log(JSON.stringify({ repairedArtifacts: count, preservedCompressedEventBytes: eventBytes }))
  }

  /** 无参数；只重定位本工程的旧 cwd，校验事件正文完全相同后才归档原文件。 */
  async run_migration() {
    let count = 0
    for (const project of await fs.readdir(this.sessions, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const dir = path.join(this.sessions, project.name)
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const source = path.join(dir, entry.name)
        const files = (await fs.readdir(source)).filter(name => /^session(?:\.v\d+)?\.jsonl\.zstd$/.test(name))
        if (!files.length) continue
        const first = zstdDecompressSync(await fs.readFile(path.join(source, files[0])))
        const header = JSON.parse(first.subarray(0, first.indexOf(10)).toString())
        const old = header.cwd
        if (typeof old !== 'string') continue
        const legacy = ['微信Harness链路', 'deepseek-harness'].some(name =>
          path.resolve(old).toLowerCase() === path.join(this.base, name).toLowerCase())
        if (!legacy) continue
        const dest = sessionDir(this.sessions, this.root, header.id)
        try { await fs.access(dest); throw new Error('迁移目标会话已存在，拒绝覆盖') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        await fs.cp(source, dest, { recursive: true })
        for (const name of files) {
          const encoded = await this.rewrite_header(await fs.readFile(path.join(source, name)))
          await fs.writeFile(path.join(dest, name), encoded)
        }
        const archived = path.join(this.backup, project.name, entry.name)
        await fs.mkdir(path.dirname(archived), { recursive: true })
        await fs.rename(source, archived)
        count++
      }
    }
    console.log(JSON.stringify({ relocatedSessions: count, originalEventsPreserved: true }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const migration = new ProductionSessionMigration(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  if (process.argv.includes('--repair-from-snapshot')) await migration.repair_from_snapshot()
  else await migration.run_migration()
}
