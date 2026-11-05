/**
 * 真实MCP文件闭环验收：通过Harness同款SDK调用独立终端组件，上传再下载测试文件。
 * 参数target、remoteRoot为已授权SSH别名与已有远端父目录；仅创建随机测试目录。
 * 不调用模型、不访问聊天数据、不发送消息。远端测试文件保留供核查。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'backend/package.json'))
const { Client } = require('@modelcontextprotocol/client')
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio')

class RemoteFileLiveSmoke {
  /** target/remoteRoot为明确目标及已有父目录；用现有SSH命令只创建一个测试目录。 */
  async run_checks(target, remoteRoot) {
    if (!target || !remoteRoot) throw Error('须显式提供SSH目标和远端测试父目录')
    const bridge = join(root, 'config/terminalConnection.json')
    const config = JSON.parse(readFileSync(bridge, 'utf8').replace(/^\uFEFF/, ''))
    const component = resolve(root, config.repositoryRoot)
    const python = process.env.DSH_PYTHON || join(root, '.venv/Scripts/python.exe')
    const temp = mkdtempSync(join(tmpdir(), 'SynLoveFileMcpCheck-'))
    const remoteDir = remoteRoot.replaceAll('\\', '/').replace(/\/$/, '') + '/FileMcpCheck-' + randomUUID().replaceAll('-', '')
    // 创建目录不经模型，也不让模型传入任意shell；固定Python程序只接受配置内SSH目标。
    const setup = [
      'import sys',
      'from fileTransfer.SshConnection import SshConnection',
      'from remoteControl.RemoteTargetConfig import RemoteTargetConfig',
      'with SshConnection(RemoteTargetConfig(sys.argv[1]),sys.argv[2]) as s: s.mkdir(sys.argv[3])',
    ].join('\n')
    const created = spawnSync(python, ['-X', 'utf8', '-c', setup, component, target, remoteDir], {
      cwd: component, windowsHide: true, encoding: 'utf8', timeout: 30000,
    })
    if (created.status !== 0) throw Error('创建隔离测试目录失败：' + (created.stderr || created.error?.name))
    const client = new Client({ name: 'synlove-file-live-smoke', version: '1.0.0' }, {
      capabilities: {}, versionNegotiation: { mode: 'auto' },
    })
    const transport = new StdioClientTransport({
      command: python, args: [join(component, 'terminalConnection/tools/TerminalMcp.py'), '--config', bridge],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stderr: 'pipe',
    })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      assert.ok(tools.tools.some(tool => tool.name === 'remote_file_transfer'))
      const devices = await this.call_tool(client, 'terminal_devices', {})
      assert.ok(Array.isArray(devices.devices) && devices.fileTargets.some(item => item.target === target))
      const source = join(temp, '中文 源文件.bin'), returned = join(temp, '返回.bin')
      const data = Buffer.concat([Buffer.from(Array.from({ length: 65536 }, (_, n) => n % 256)), Buffer.from('欣爱真实MCP文件传输')])
      writeFileSync(source, data)
      const remotePath = remoteDir + '/中文 文件.bin'
      const upload = await this.call_tool(client, 'remote_file_transfer', {
        source: 'local', sourcePath: source, target, targetPath: remotePath,
      })
      const download = await this.call_tool(client, 'remote_file_transfer', {
        source: target, sourcePath: remotePath, target: 'local', targetPath: returned,
      })
      assert.deepEqual(readFileSync(returned), data)
      assert.equal(upload.sha256, createHash('sha256').update(data).digest('hex'))
      assert.equal(download.sha256, upload.sha256)
      const listing = await this.call_tool(client, 'remote_file_list', { target, path: remoteDir })
      assert.ok(listing.entries.some(item => item.name === '中文 文件.bin'))
      const refused = await client.callTool({ name: 'remote_file_transfer',
        arguments: { source: 'local', sourcePath: source, target, targetPath: remotePath } })
      assert.equal(refused.isError, true)
      console.log(JSON.stringify({ ok: true, tools: tools.tools.length,
        devices: devices.devices.map(item => ({ id: item.id, name: item.name, online: item.online })),
        uploadVerified: upload.verified, downloadVerified: download.verified,
        bytes: data.length, sha256: upload.sha256, remoteTestDirectory: remoteDir, overwriteRejected: true }))
    } finally {
      await client.close()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  /** client/name/args为MCP会话、固定工具和参数；业务失败不能误当通过。 */
  async call_tool(client, name, args) {
    const reply = await client.callTool({ name, arguments: args })
    const value = JSON.parse(reply.content[0].text)
    assert.equal(reply.isError, false, value.error)
    assert.notEqual(value.ok, false, value.error)
    return value
  }
}

await new RemoteFileLiveSmoke().run_checks(process.argv[2], process.argv[3])
