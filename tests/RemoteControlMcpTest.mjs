/**
 * 远控 MCP 客户端兼容性测试：复用 Harness 实际安装的 MCP SDK。
 * 注册参数：DSH_PYTHON 可选择解释器；默认发行目录 .venv，完全不连接真实远程电脑。
 * 功能：真实 stdio 握手、列举工具、ping、参数失败响应与进程关闭验证。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'backend', 'package.json'))
const { Client } = require('@modelcontextprotocol/client')
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio')

class RemoteControlMcpTest {
  /** 无参数；建立与 Harness 相同的 MCP 连接，执行无副作用契约检查后回收子进程。 */
  async run_test() {
    const component = JSON.parse(readFileSync(join(root, 'config/terminalConnection.json'), 'utf8')).repositoryRoot
    const temp = mkdtempSync(join(tmpdir(), 'synloveMcpTest-'))
    const config = join(temp, 'Admin.json')
    writeFileSync(config, JSON.stringify({ adminURL: 'http://127.0.0.1:1', adminToken: 'isolatedTest' }))
    const client = new Client({ name: 'synlove-isolated-test', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    const transport = new StdioClientTransport({
      command: process.env.DSH_PYTHON || join(root, '.venv', 'Scripts', 'python.exe'),
      args: [resolve(root, component, 'terminalConnection/tools/TerminalMcp.py'), '--config', config],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stderr: 'pipe',
    })
    try {
      await client.connect(transport)
      const reply = await client.listTools()
      assert.deepEqual(reply.tools.map(tool => tool.name),
        ['terminal_devices', 'remote_cmd_list', 'remote_cmd_probe', 'remote_cmd_run', 'terminal_music',
          'remote_file_targets', 'remote_file_list', 'remote_file_transfer'])
      await client.ping()
      // 期限在读取任何目标配置、建立任何 SSH 连接前即被拒绝。
      const invalid = await client.callTool({
        name: 'remote_cmd_run', arguments: { target: 'isolated-test', command: 'echo test', timeoutSec: 0 },
      })
      assert.equal(invalid.isError, true)
      assert.equal(JSON.parse(invalid.content[0].text).ok, false)
      console.log('PASS: Harness MCP SDK 握手、8 个终端工具、心跳、参数失败反馈')
    } finally {
      await client.close()
      rmSync(temp, { recursive: true, force: true })
    }
  }
}

await new RemoteControlMcpTest().run_test()
