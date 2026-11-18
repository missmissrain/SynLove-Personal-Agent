/**
 * 千问联网搜索provider：官方新模型走原生流式接口，其他兼容端点保留Chat Completions。
 * 参数：apiKeyEnv 默认 DASHSCOPE_API_KEY（走凭据服务解析），baseURL 默认百炼兼容地址，model 默认 qwen3.8-flash。
 * 它只注册到 ctx.web 的搜索注册表，不拥有 web 服务；请求格式与原生 fetch 都留在本包内。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'

/** provider 的稳定 ID，供 web.searchProvider 引用。 */
const QWEN_PROVIDER_ID = 'qwen'
/** 默认百炼兼容端点，后面会拼 /chat/completions。 */
const QWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
/** 默认搜索模型：flash 已支持联网搜索。 */
const QWEN_DEFAULT_MODEL = 'qwen3.8-flash'
/** 默认答案长度上限，避免一次搜索烧掉太多 token。 */
const QWEN_DEFAULT_MAX_TOKENS = 4096
/** 默认凭据名，与模型通道使用同一把百炼密钥。 */
const DEFAULT_API_KEY_ENV = 'DASHSCOPE_API_KEY'
/** Responses 协议的默认搜索工具名。 */
const DEFAULT_RESPONSES_TOOL = 'web_search'
/** 每次请求附带的身份标识。 */
const USER_AGENT = 'synlove-qwen-search/1.0'

/**
 * 把千问返回的来源条目映射成统一 source。
 * 参数 result 为 search_results[] 的一项；空字段直接省略，不写空串。
 */
function map_result(result) {
  return {
    url: String(result.url ?? ''),
    ...result.title ? { title: String(result.title) } : {},
    ...result.snippet ? { snippet: String(result.snippet) } : {},
    ...result.published_at ?? result.date ? { publishedAt: String(result.published_at ?? result.date) } : {},
  }
}

/**
 * 把兼容接口的响应体映射成统一搜索结果。
 * 参数 response 为已解析的 chat-completions 响应；有来源就给来源，没有只给正文。
 */
function map_response(response) {
  const choice = response.output?.choices?.[0] ?? response.choices?.[0]
  const value = choice?.message?.content ?? response.output?.text
  const content = Array.isArray(value) ? value.map(block => block.text ?? '').join('') : value
  const raw = response.output?.search_info?.search_results ?? response.search_info?.search_results ?? response.search_results ?? response.citations ?? []
  const sources = (Array.isArray(raw) ? raw : []).map(row => typeof row === 'string' ? { url: row } : map_result(row)).filter(row => {
    try { const url = new URL(row.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
  })
  return {
    ...content != null && String(content).length > 0 ? { content: String(content) } : {},
    sources,
    truncated: choice?.finish_reason === 'length',
  }
}

/** 判断错误是否为 fetch 中止。 */
function is_abort(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 正整数校验：maxTokens 必须是能发给服务端的值。 */
function is_positive_integer(value) {
  return Number.isInteger(value) && value > 0
}

/** 千问联网搜索 provider；每次操作前重新解析配置与密钥。 */
class QwenSearchProvider {
  /** resolveOptions 返回本次操作要用的密钥解析器、端点、模型与答案长度。 */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions
    this.id = QWEN_PROVIDER_ID
  }
  /** 无参数；有密钥来源、端点有效、长度合法才算可用。 */
  available() {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL) && is_positive_integer(options.maxTokens)
  }
  /** options 为本次操作的配置；返回本次要用的密钥，缺失时报明确错误。 */
  async resolve_key(options, signal) {
    let resolved
    try {
      resolved = await (options.resolveApiKey?.() ?? Promise.resolve(undefined))
    } catch (error) {
      if (is_abort(error)) throw new WebError('Qwen search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Qwen search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
    if ((options.apiKey?.length ?? 0) > 0) return options.apiKey
    throw new WebError(`Qwen search has no API key for "${options.apiKeyEnv ?? DEFAULT_API_KEY_ENV}"; store it through the credentials service (the web Models page writes it) or export it in the launching environment`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
  /** request 至少含 query；signal 用于取消。返回正文与来源。 */
  async search(request, signal) {
    const options = this.resolveOptions()
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 120000)
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline
    const apiKey = await this.resolve_key(options, signal)
    if (options.protocol === 'responses') {
      return this.search_responses(request, options, apiKey, signal, deadline)
    }
    // 阿里云新多模态模型使用原生流式接口，才能可靠返回 search_info 来源。
    // 自定义兼容网关保留原协议，不能擅自改写第三方主机或转发密钥。
    const url = new URL(options.baseURL)
    const native = url.hostname.endsWith('.aliyuncs.com') && /^qwen3\.[5-9]/.test(options.model)
    const endpoint = native
      ? `${url.origin}/api/v1/services/aigc/multimodal-generation/generation`
      : `${options.baseURL.replace(/\/$/, '')}/chat/completions`
    const parameters = { max_tokens: options.maxTokens, enable_thinking: false, enable_search: true,
      search_options: { forced_search: true, enable_source: true, enable_citation: true } }
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: native ? 'text/event-stream' : 'application/json',
          'user-agent': USER_AGENT,
          ...(native ? { 'X-DashScope-SSE': 'enable' } : {}),
        },
        body: JSON.stringify(native ? {
          model: options.model,
          input: { messages: [{ role: 'user', content: [{ text: request.query }] }] },
          parameters: { ...parameters, incremental_output: true, result_format: 'message' },
        } : {
          model: options.model,
          ...parameters,
          stream: false,
          messages: [{ role: 'user', content: request.query }],
          // 千问自带搜索的两个开关：enable_search 打开搜索，forced_search 保证真的去搜。
          enable_search: true,
          search_options: parameters.search_options,
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (signal.aborted) throw new WebError(deadline.aborted ? '千问搜索超过120秒请求期限' : 'Qwen search aborted', deadline.aborted ? 'WEB_SEARCH_TIMEOUT' : 'WEB_ABORTED', { cause: error })
      throw new WebError(`Qwen search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      let message = `Qwen search API error (HTTP ${response.status})`
      try {
        const parsed = await response.json()
        const detail = typeof parsed.error === 'string' ? parsed.error
          : parsed.error?.message ?? parsed.message
        if (detail !== undefined && String(detail).length > 0) message = String(detail)
      } catch (error) {
        if (is_abort(error)) throw new WebError('Qwen search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }
    try {
      return native ? await this.read_stream(response, signal) : map_response(await response.json())
    } catch (error) {
      if (signal.aborted) throw new WebError(deadline.aborted ? '千问搜索超过120秒请求期限' : 'Qwen search aborted', deadline.aborted ? 'WEB_SEARCH_TIMEOUT' : 'WEB_ABORTED', { cause: error })
      throw new WebError(`Qwen returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
  /** 通过 Responses + web_search 调用兼容网关的服务端搜索。 */
  async search_responses(request, options, apiKey, signal, deadline) {
    let response
    try {
      response = await fetch(`${options.baseURL}/responses`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          model: options.model,
          input: request.query,
          max_output_tokens: options.maxTokens,
          tools: [{ type: options.searchTool ?? DEFAULT_RESPONSES_TOOL }],
        }),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw new WebError(deadline.aborted ? '搜索超过请求期限' : 'Responses search aborted',
        deadline.aborted ? 'WEB_SEARCH_TIMEOUT' : 'WEB_ABORTED', { cause: error })
      return this.search_fallback(request, options, signal, error)
    }
    if (!response.ok) {
      return this.search_fallback(request, options, signal,
        new Error(`Responses search API error (HTTP ${response.status})`))
    }
    const body = await response.json()
    const sources = []
    for (const item of body.output ?? []) {
      for (const content of item.content ?? []) {
        for (const citation of content.annotations ?? []) {
          const url = citation.url ?? citation.uri
          if (url) sources.push({ url: String(url), title: citation.title ? String(citation.title) : undefined })
        }
      }
    }
    return { ...(body.output_text ? { content: String(body.output_text) } : {}), sources, truncated: false }
  }
  /** 首选 Responses 失活时，使用配置的千问搜索兜底。 */
  async search_fallback(request, options, signal, cause) {
    if (!options.fallbackBaseURL || !options.resolveFallbackApiKey) {
      throw new WebError(`Responses search unavailable: ${String(cause)}`, 'WEB_PROVIDER_ERROR', { cause })
    }
    const key = await options.resolveFallbackApiKey()
    if (!key) throw new WebError('Fallback Qwen search credential missing', 'WEB_PROVIDER_CREDENTIAL_MISSING', { cause })
    const response = await fetch(`${options.fallbackBaseURL}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: options.fallbackModel,
        max_tokens: options.maxTokens,
        stream: false,
        messages: [{ role: 'user', content: request.query }],
        enable_search: true,
        search_options: { forced_search: true },
      }),
      signal,
    })
    if (!response.ok) throw new WebError(`Fallback Qwen search API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR', { cause })
    return map_response(await response.json())
  }
  /** response为原生SSE响应，signal为总期限；合并增量正文和全部来源，拒绝缺少终态的半截响应。 */
  async read_stream(response, signal) {
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', content = '', bytes = 0, finished = false, truncated = false
    const sources = new Map()
    try {
      while (true) {
        signal.throwIfAborted()
        const part = await reader.read()
        bytes += part.value?.byteLength ?? 0
        if (bytes > 2000000) throw Error('千问搜索响应超过2MB上限')
        buffer += part.done ? decoder.decode() + '\n' : decoder.decode(part.value, { stream: true })
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          const raw = JSON.parse(data)
          if (raw.code && !raw.output) throw Error(`千问搜索返回错误：${raw.code}`)
          const result = map_response(raw)
          content += result.content ?? ''
          for (const item of result.sources) sources.set(item.url, item)
          const reason = raw.output?.choices?.[0]?.finish_reason ?? raw.choices?.[0]?.finish_reason
          if (reason && reason !== 'null') { finished = true; truncated ||= result.truncated }
        }
        if (part.done) break
      }
      if (!finished) throw Error('千问搜索未返回正式终态，不能把半截响应当完整结果')
      return { content, sources: [...sources.values()], truncated }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}

/** Cordis 插件名，供加载器诊断识别。 */
const name = 'web-search-qwen'
/** 注册到 web 服务接缝。 */
const inject = ['web']
const Config = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  model: z.string().default(QWEN_DEFAULT_MODEL),
  maxTokens: z.number().step(1).min(1).default(QWEN_DEFAULT_MAX_TOKENS),
  protocol: z.string().default('chat-completions'),
  searchTool: z.string().default(DEFAULT_RESPONSES_TOOL),
  fallbackBaseURL: z.string().optional(),
  fallbackModel: z.string().optional(),
  fallbackApiKeyEnv: z.string().role('credential-ref').optional(),
})

/**
 * 把当前配置整理成一次搜索要用的选项：密钥优先走凭据服务，其次启动环境。
 * 参数 ctx 为插件上下文，config 为当前生效的配置段。
 */
function resolve_options(ctx, config) {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literal = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...literal === undefined ? {} : { apiKey: literal },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get('DASHSCOPE_BASE_URL')?.value ?? QWEN_DEFAULT_BASE_URL,
    model: config.model ?? QWEN_DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? QWEN_DEFAULT_MAX_TOKENS,
    protocol: config.protocol ?? 'chat-completions',
    searchTool: config.searchTool ?? DEFAULT_RESPONSES_TOOL,
    fallbackBaseURL: config.fallbackBaseURL,
    fallbackModel: config.fallbackModel ?? QWEN_DEFAULT_MODEL,
    resolveFallbackApiKey: config.fallbackApiKeyEnv === undefined ? undefined : async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(credentialRef(config.fallbackApiKeyEnv)))?.value
      const ambient = launchEnvironmentOf(ctx).get(config.fallbackApiKeyEnv)
      return ambient !== undefined ? ambient.value : undefined
    },
  }
}

/** 插件入口：把千问搜索 provider 注册进 ctx.web。 */
function apply(ctx, config) {
  let current = () => config
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, 'web-search-qwen', Config, config, {
      setSource: source => { current = source },
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new QwenSearchProvider(() => resolve_options(ctx, current())))
}

export { Config, DEFAULT_API_KEY_ENV, QWEN_DEFAULT_BASE_URL, QWEN_DEFAULT_MAX_TOKENS, QWEN_DEFAULT_MODEL, QWEN_PROVIDER_ID, QwenSearchProvider, apply, inject, name }
