/**
 * 千问自带联网搜索的 provider：走百炼 OpenAI 兼容 Chat Completions，带 enable_search + forced_search。
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
const QWEN_DEFAULT_MAX_TOKENS = 1024
/** 默认凭据名，与模型通道使用同一把百炼密钥。 */
const DEFAULT_API_KEY_ENV = 'DASHSCOPE_API_KEY'
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
  const content = response.choices?.[0]?.message?.content
  const raw = response.search_info?.search_results ?? response.search_results ?? response.citations ?? []
  const sources = raw.map(row => typeof row === 'string' ? { url: row } : map_result(row)).filter(row => row.url)
  return {
    ...content != null && String(content).length > 0 ? { content: String(content) } : {},
    sources,
    truncated: false,
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
    const apiKey = await this.resolve_key(options, signal)
    let response
    try {
      response = await fetch(`${options.baseURL}/chat/completions`, {
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
          max_tokens: options.maxTokens,
          stream: false,
          messages: [{ role: 'user', content: request.query }],
          // 千问自带搜索的两个开关：enable_search 打开搜索，forced_search 保证真的去搜。
          enable_search: true,
          search_options: { forced_search: true },
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (is_abort(error)) throw new WebError('Qwen search aborted', 'WEB_ABORTED', { cause: error })
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
      return map_response(await response.json())
    } catch (error) {
      if (is_abort(error)) throw new WebError('Qwen search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Qwen returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
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
