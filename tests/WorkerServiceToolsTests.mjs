/**
 * 子Agent终端桥接回归：真实主仓库不再含旧RemoteCmdMcp.py时，仍解析外部终端入口。
 * 参数无；仅使用临时配置与本机文件，不连接网络、不调用模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerServiceTools } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/WorkerServiceTools.js'

test('独立终端仓库的桥接配置决定子Agent MCP入口，无需旧远控文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'SynLoveWorkerBridge-'))
  try {
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'terminalConnection.json'), JSON.stringify({
      repositoryRoot: '../TerminalComponent', adminToken: 'test-only',
    }))
    const specs = new WorkerServiceTools(root).service_specs()
    assert.equal(specs.length, 5)
    assert.equal(specs[0][1], join(root, '..', 'TerminalComponent', 'terminalConnection/tools/TerminalMcp.py'))
    assert.deepEqual(specs[0][2], ['--config', join(root, 'config/terminalConnection.json')])
    assert.ok(specs[0][3] > 300000)
    assert.ok(specs.every(spec => !JSON.stringify(spec).includes('test-only')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
