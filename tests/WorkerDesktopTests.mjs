/**
 * 桌面配置回归：临时目录验证配置隔离、凭据要求与缺失能力提示，不操作真实桌面。
 * 参数无；使用现有Node依赖，不安装服务，不读取生产密钥。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkerDesktopTools } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/WorkerDesktopTools.js'

test('桌面配置默认关闭，合法回环或HTTPS独立鉴权，不接受跨机器明文',async()=>{
  const root=mkdtempSync(join(tmpdir(),'synlove-desktop-'))
  mkdirSync(join(root,'config'))
  const tool=new WorkerDesktopTools(root),sections=[]
  const put=value=>writeFileSync(join(root,'config/windowsMcpConfig.json'),JSON.stringify(value))
  try{
    assert.equal(tool.read_config(),undefined)
    assert.equal(await tool.mount_tools({systemPrompt:{section:s=>sections.push(s)}}),0)
    assert.match(sections[0].text,/不能用Windows桌面工具/)
    const config={enabled:true,url:'http://127.0.0.1:17864/mcp',token:'x'.repeat(40)}
    put(config);assert.equal(tool.read_config().toolCallTimeoutMs,120000)
    put({...config,url:'http://example.com/mcp'});assert.throws(()=>tool.read_config(),/HTTPS/)
    put({...config,url:'https://example.com/mcp'});assert.equal(tool.read_config().url,'https://example.com/mcp')
    put({...config,token:''});assert.throws(()=>tool.read_config(),/凭据/)
    put({...config,toolCallTimeoutMs:0});assert.throws(()=>tool.read_config(),/超时/)
  }finally{rmSync(root,{recursive:true,force:true})}
})
