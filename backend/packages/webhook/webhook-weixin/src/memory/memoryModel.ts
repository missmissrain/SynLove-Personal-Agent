/**
 * 记忆更新的"模型客户端"：本地 Gemma 或云端模型，二者可切换。
 *
 * 为什么需要可切换：本地 Gemma 免费、但要占约 5.3GB 显存（这张卡只有 8GB）。
 * 用户如果在跑游戏/训练，等显存空出来可能要等很久；而记忆更新**不是急事**，
 * 但也不能永远不做。所以给一条"直接用云端模型"的路：不占显存，立刻能跑。
 *
 * 两条路都是 OpenAI 兼容协议，所以这里只实现一个调用器，靠参数区分：
 * - 本地：base_url 指向 llama-server，不需要 key；
 * - 云端：base_url / model / key 从 `config/modelConfig.json` 里取（唯一配置源）。
 *
 * @module dsh-webhook-weixin/memory-model
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'

/** 用哪个引擎做记忆更新。 */
export type MemoryEngine = 'gemma' | 'cloud'

/** 构造参数。 */
export interface MemoryModelOptions {
  readonly engine: MemoryEngine
  /** 本地 Gemma 的 OpenAI 兼容根，默认取 GEMMA_LOCAL_BASE_URL。 */
  readonly gemma_base_url?: string
  /** 本地 Gemma 的模型名。 */
  readonly gemma_model?: string
  /** 云端模型，写 `provider/model`（例如 `volcengine/doubao-seed-2-0-lite-260215`）。 */
  readonly cloud_model?: string
  /** 备用云端模型，主模型失败时使用（provider/model）。 */
  readonly cloud_fallback?: string
  /** modelConfig.json 路径；默认按项目结构推导。 */
  readonly config_path?: string
  /** 单次调用超时（毫秒），默认 5 分钟（本地冷唤醒要 ~18s，云端可能更慢）。 */
  readonly timeout_ms?: number
  /** 可注入 fetch，便于测试。 */
  readonly fetch_impl?: typeof fetch
}

/** 记忆模型客户端。 */
export interface MemoryModel {
  /** 人类可读的引擎说明（写进探针/日志）。 */
  readonly label: string
  /** 纯文本补全；`max_tokens` 可按需调整（摘要的分块小结只要几百 token）。 */
  complete(prompt: string, max_tokens?: number): Promise<string>
  /** 图片一句话描述。 */
  describe_image(input: { data: Uint8Array, media_type: string }): Promise<string>
}

/** 默认的云端模型（配置里没有指定时的兜底）。 */
const DEFAULT_CLOUD_MODEL = 'volcengine/doubao-seed-2-0-pro-260215'

/** 项目里 modelConfig.json 的位置（本包 → 项目根 → config）。 */
function default_config_path(): string {
  // 本文件在 packages/webhook/webhook-weixin/src/memory/ 下
  return join(process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd(), 'config', 'modelConfig.json')
}

/** 云端连接信息。 */
interface CloudTarget {
  readonly base_url: string
  readonly model: string
  readonly api_key?: string
}

/**
 * 从配置解析云端目标；解析不出来返回 undefined。
 *
 * 密钥现在单独放在与 modelConfig.json **同目录的 secrets.json**（见项目 README/启动器说明），
 * 所以这里在两个文件里找 apiKey：模型定义读 modelConfig，密钥读 secrets。
 *
 * @param config_path - modelConfig.json 的路径（secrets.json 按同目录推导）。
 * @param cloud_model - `provider/model` 形式的目标。
 */
export function resolve_cloud_target(config_path: string, cloud_model: string): CloudTarget | undefined {
  try {
    const config = JSON.parse(readFileSync(config_path, 'utf8')) as {
      providers?: Record<string, { baseURL?: string, apiKey?: string, models?: Array<{ id: string }> }>
    }
    // 模型 id 可能自带 provider 前缀（例如 workbuddy/glm-5.3），只按第一个斜杠切分。
    const cut = cloud_model.indexOf('/')
    const provider_id = cut < 0 ? cloud_model : cloud_model.slice(0, cut)
    const model_id = cut < 0 ? undefined : cloud_model.slice(cut + 1)
    const provider = config.providers?.[provider_id ?? '']
    if (provider === undefined) return undefined
    const model = model_id !== undefined && model_id !== ''
      ? model_id
      : provider.models?.[0]?.id
    if (model === undefined || provider.baseURL === undefined) return undefined
    // 密钥优先取 secrets.json；缺文件/缺字段时回退到 modelConfig 里的旧位置
    const api_key = provider.apiKey ?? read_secret_api_key(config_path, provider_id ?? '')
    return {
      base_url: provider.baseURL.replace(/\/$/, ''),
      model,
      ...api_key === undefined ? {} : { api_key },
    }
  } catch {
    return undefined
  }
}

/** 从 `secrets.json`（与配置文件同目录）读某个 provider 的 apiKey；读不到返回 undefined。 */
function read_secret_api_key(config_path: string, provider_id: string): string | undefined {
  try {
    const secrets_path = join(dirname(config_path), 'secrets.json')
    if (!existsSync(secrets_path)) return undefined
    const secrets = JSON.parse(readFileSync(secrets_path, 'utf8')) as {
      providers?: Record<string, { apiKey?: string }>
    }
    const key = secrets.providers?.[provider_id]?.apiKey
    return typeof key === 'string' && key !== '' ? key : undefined
  } catch {
    return undefined
  }
}

/**
 * 创建记忆模型客户端。
 *
 * @param options - 引擎选择与端点参数。
 */
export function create_memory_model(options: MemoryModelOptions): MemoryModel {
  const timeout_ms = options?.timeout_ms ?? Number(process.env.SYNLOVE_LLM_TIMEOUT_MS ?? '300000')
  const fetch_impl = options?.fetch_impl ?? fetch
  const engine: MemoryEngine = options.engine
  const config_path = options.config_path ?? default_config_path()

  let base_url: string
  let model: string
  let api_key: string | undefined
  let label: string

  if (engine === 'cloud') {
    const wanted = options.cloud_model?.trim() || DEFAULT_CLOUD_MODEL
    const target = resolve_cloud_target(config_path, wanted)
    if (target === undefined) {
      // 配置里找不到就退回本地——总比"记忆永远不更新"好，并留下明显痕迹。
      probe('memory-model', 'cloud.resolve_failed', { wanted, config_path })
      const fallback = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
      base_url = fallback
      model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M'
      api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY']
      label = `本地 Gemma（云端 ${wanted} 解析失败，已回退）`
    } else {
      base_url = target.base_url
      model = target.model
      api_key = target.api_key
      label = `云端 ${wanted}`
    }
  } else {
    base_url = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
    model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M'
    api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? 'SYNLOVE_LLM_API_KEY']
    label = `本地 Gemma（${model}）`
  }

  /** 统一的一次 chat 调用。 */
  /** 为指定端点构造一次补全；失败时保留响应正文，便于定位上游错误。 */
  const make_chat = (target_base_url: string, target_model: string,
                     target_key: string | undefined, target_label: string) =>
    async (content: unknown, max_tokens: number): Promise<string> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout_ms)
      try {
        const response = await fetch_impl(`${target_base_url}/chat/completions`, {
          redirect: 'error',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...target_key === undefined ? {} : { Authorization: `Bearer ${target_key}` },
          },
          body: JSON.stringify({
            model: target_model,
            messages: [{ role: 'user', content }],
            temperature: 0.2,
            max_tokens,
            stream: false,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(`记忆模型 HTTP ${response.status}（${target_label}）${detail.slice(0, 120)}`)
        }
        const parsed = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>
          usage?: { prompt_tokens?: number, completion_tokens?: number }
        }
        probe('memory-model', 'completion', {
          label: target_label, prompt_tokens: parsed.usage?.prompt_tokens,
          completion_tokens: parsed.usage?.completion_tokens,
        })
        const text = parsed.choices?.[0]?.message?.content
        if (typeof text !== 'string' || !text.trim()) throw new Error('记忆模型未返回有效正文，保留原记忆等待重试')
        return text
      } finally {
        clearTimeout(timer)
      }
    }

  const chat = make_chat(base_url, model, api_key, label)
  const fallback_wanted = engine === 'cloud'
    ? (options.cloud_fallback?.trim() || process.env.DSH_MEMORY_CLOUD_FALLBACK?.trim() || '')
    : ''
  const fallback_target = fallback_wanted === ''
    ? undefined : resolve_cloud_target(config_path, fallback_wanted)
  const fallback_chat = fallback_target === undefined ? undefined
    : make_chat(fallback_target.base_url, fallback_target.model, fallback_target.api_key,
                `云端备用 ${fallback_wanted}`)

  /** 优先主模型，失败时切备用模型，避免摘要因为上游 502 整天空转。 */
  const complete = async (content: unknown, max_tokens: number): Promise<string> => {
    try {
      return await chat(content, max_tokens)
    } catch (error) {
      if (fallback_chat === undefined) throw error
      probe('memory-model', 'fallback', {
        from: label, error: String(error).slice(0, 200),
      })
      return await fallback_chat(content, max_tokens)
    }
  }

  return {
    label,
    complete: (prompt, max_tokens) => complete(prompt, max_tokens ?? 2000),
    describe_image: async input => {
      const instruction = '用一句中文描述这张图片的主要内容（谁/什么、在哪、在做什么、明显的文字）。'
        + '只输出这一句话，不要评价、不要客套。'
      return complete([
        { type: 'text', text: instruction },
        {
          type: 'image_url',
          image_url: { url: `data:${input.media_type};base64,${Buffer.from(input.data).toString('base64')}` },
        },
      ], 200)
    },
  }
}
