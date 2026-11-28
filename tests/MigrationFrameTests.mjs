/**
 * 多帧会话迁移回归：使用独立三帧夹具，证明迁移仅改头帧、保留所有事件帧原始字节。
 * 参数：node --test tests/MigrationFrameTests.mjs；无磁盘写入、无生产数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { ProductionSessionMigration } from '../tools/ProductionSessionMigration.mjs'
import { scanZstdFrames } from '../backend/packages/session/session-persistence-jsonl/lib/types/zstd.js'

test('多个事件帧经过迁移后全部保留，不能把首帧解压误当作完整会话', async () => {
  const header = zstdCompressSync(JSON.stringify({ id: 'fixture', cwd: 'old' }) + '\n')
  const events = Buffer.concat([zstdCompressSync('event-one\n'), zstdCompressSync('event-two\n')])
  const migrated = await new ProductionSessionMigration('new').rewrite_header(Buffer.concat([header, events]))
  const frames = scanZstdFrames(migrated).frames
  assert.equal(frames.length, 3)
  assert.equal(JSON.parse(zstdDecompressSync(migrated.subarray(0, frames[0].end)).toString()).cwd, 'new')
  assert.ok(migrated.subarray(frames[0].end).equals(events))
  const contents = frames.slice(1).map(f => zstdDecompressSync(migrated.subarray(f.start, f.end)).toString())
  assert.deepEqual(contents, ['event-one\n', 'event-two\n'])
})
