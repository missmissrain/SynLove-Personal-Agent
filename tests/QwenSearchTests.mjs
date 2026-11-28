/**
 * 千问搜索协议回归：模拟原生SSE与兼容JSON，验证来源、截断、不完整响应和明确超时。
 * 参数无；node --test tests/QwenSearchTests.mjs，无真实密钥、模型或联网调用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QwenSearchProvider } from '../backend/packages/web/web-search-qwen/lib/index.js'

class SearchFixture {
  /** config为单测选项；默认使用官方地址触发原生协议，不解析真实凭据。 */
  constructor(config = {}) {
    this.provider = new QwenSearchProvider(() => ({apiKey:'fixture',baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.8-flash',maxTokens:4096,...config}))
  }
  /** body为模拟报文，action接收实际请求；运行后恢复fetch。 */
  async run_search(body, action) {
    const original = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      action?.(url, options)
      return new Response(body,{status:200})
    }
    try { return await this.provider.search({query:'验证搜索'}) }
    finally { globalThis.fetch = original }
  }
}

test('原生SSE合并增量、来源去重、末行无换行、显式截断', async () => {
  const fixture = new SearchFixture()
  const rows = [
    {output:{choices:[{message:{content:[{text:'第一段'}]},finish_reason:'null'}],search_info:{search_results:[{url:'https://example.com',title:'来源'},{url:'javascript:alert(1)'}]}}},
    {output:{choices:[{message:{content:[{text:'第二段'}]},finish_reason:'length'}],search_info:{search_results:[{url:'https://example.com',title:'来源'}]}}}
  ]
  const result = await fixture.run_search(rows.map(row=>'data: '+JSON.stringify(row)).join('\n\n'),(url, options)=>{
    assert.match(url,/multimodal-generation\/generation$/)
    assert.equal(JSON.parse(options.body).parameters.search_options.forced_search,true)
    assert.equal(options.headers['X-DashScope-SSE'],'enable')
    assert.equal(options.headers.accept,'text/event-stream')
  })
  assert.equal(result.content,'第一段第二段')
  assert.equal(result.sources.length,1)
  assert.equal(result.truncated,true)
})

test('兼容网关不改写主机和协议，保留完整正文', async () => {
  const result = await new SearchFixture({baseURL:'https://gateway.example/v1'}).run_search(JSON.stringify({
    choices:[{message:{content:'完整正文'},finish_reason:'stop'}],citations:['https://example.com']
  }),(url)=>assert.equal(url,'https://gateway.example/v1/chat/completions'))
  assert.equal(result.content,'完整正文')
  assert.equal(result.sources.length,1)
})

test('半截流不当完整结果；请求期限真实中止并分类', async () => {
  await assert.rejects(new SearchFixture().run_search('data: '+JSON.stringify({output:{choices:[{message:{content:[{text:'半段'}]},finish_reason:'null'}]}})),/终态/)
  const original = globalThis.fetch
  globalThis.fetch = async (_,options) => new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})
  })
  const keep = setInterval(()=>{},100)
  try { await assert.rejects(new SearchFixture({timeoutMs:20}).provider.search({query:'超时'}),error=>error.code==='WEB_SEARCH_TIMEOUT') }
  finally { clearInterval(keep); globalThis.fetch=original }
})
