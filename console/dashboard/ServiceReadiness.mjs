/**
 * ServiceReadiness：只读检查本机按需音频服务的启动条件，与“端口正在监听”分开。
 * 参数 project：链路根目录；env：环境变量（默认 process.env）；checkPython：可注入依赖检查器。
 * 默认检查 Python 模块位置、启动脚本与本机模型文件，不加载权重、不启动服务、不下载模型。
 */
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { execFile } from 'node:child_process'

export class ServiceReadiness {
  /** 参数 options：项目目录、环境和测试依赖；本地检查结果缓存 5 分钟，失败缓存 30 秒。 */
  constructor({ project, env = process.env, checkPython } = {}) {
    this.project = project
    this.env = env
    this.checkPython = checkPython ?? ((python, modules) => this.check_python(python, modules))
    this.cache = new Map()
  }

  /** 参数 file：预期的非空文件；跟随符号链接验证实际模型权重，禁止只看目录是否存在。 */
  has_file(file) {
    try { const stat = statSync(file); return stat.isFile() && stat.size > 0 } catch { return false }
  }

  /** 参数 path：来自启动配置的路径；展开当前用户目录并按项目根目录解析相对路径。 */
  local_path(path) {
    const home = this.env.USERPROFILE || this.env.HOME || ''
    const text = String(path).replace(/^~(?=[\\/]|$)/, home)
    return isAbsolute(text) ? text : resolve(this.project, text)
  }

  /** 参数 python/modules：与启动器相同的解释器及模块名；仅查找模块，不执行推理或导入模型。 */
  check_python(python, modules) {
    const code = 'import importlib.util,json,sys; print(json.dumps(all(importlib.util.find_spec(m) is not None for m in json.loads(sys.argv[1]))))'
    return new Promise(resolvePromise => {
      execFile(python, ['-c', code, JSON.stringify(modules)],
        { windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: 'utf8', env: { ...this.env, PYTHONUTF8: '1' } },
        (error, stdout) => resolvePromise(!error && stdout.trim() === 'true'))
    })
  }

  /** 参数 model：Whisper 模型名或本地目录；仅接受完整的现有模型缓存，不把可下载等同已可用。 */
  whisper_model(model) {
    const complete = path => ['model.bin', 'config.json', 'tokenizer.json'].every(file => this.has_file(join(path, file)))
    if (!model) return false
    const direct = this.local_path(model)
    if (existsSync(direct)) return complete(direct)
    const home = this.env.USERPROFILE || this.env.HOME || ''
    const cache = this.env.HF_HUB_CACHE || this.env.HUGGINGFACE_HUB_CACHE ||
      join(this.env.HF_HOME || join(home, '.cache', 'huggingface'), 'hub')
    const repo = String(model).includes('/') ? String(model) : `Systran/faster-whisper-${model}`
    const root = join(cache, `models--${repo.replaceAll('/', '--')}`)
    try {
      const ref = readFileSync(join(root, 'refs', 'main'), 'utf8').trim()
      if (!/^[a-f0-9]{40,64}$/.test(ref)) return false
      return complete(join(root, 'snapshots', ref))
    } catch { return false }
  }

  /** 参数 ckpt：Breeze 检查点目录；验证配置、分词器及索引中每一片模型权重。 */
  breeze_model(ckpt) {
    if (!['config.json', 'tokenizer.json', 'model.safetensors.index.json'].every(file => this.has_file(join(ckpt, file)))) return false
    try {
      const index = JSON.parse(readFileSync(join(ckpt, 'model.safetensors.index.json'), 'utf8'))
      const files = [...new Set(Object.values(index.weight_map ?? {}))]
      return files.length > 0 && files.every(file => typeof file === 'string' && !/[\\/]/.test(file) && this.has_file(join(ckpt, file)))
    } catch { return false }
  }

  /**
   * 参数 name/cfg：服务名及统一注册配置；判断"按需服务现在能不能被拉起来"。
   *
   * 覆盖 TTS / ASR / 本地大模型三种按需服务：只看本机依赖与模型是否齐备，
   * 不加载权重、不启动进程。托管与本机回环的外部配置都适用——灯亮的标准是
   * "能用"，而不是"现在正在跑"。
   */
  async assess(name, cfg) {
    if (!['tts', 'asr', 'llm'].includes(name)) return false
    try {
      const url = new URL(cfg.baseURL)
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname.replace(/\/$/, '') !== '/v1' || url.username || url.password || url.search || url.hash) return false
    } catch { return false }
    const key = JSON.stringify([name, cfg, this.env.BREEZE_PYTHON, this.env.BREEZE_CKPT, this.env.BREEZE_REPO,
      this.env.WHISPER_PYTHON, this.env.DSH_PYTHON, this.env.HF_HOME, this.env.HF_HUB_CACHE, this.env.HUGGINGFACE_HUB_CACHE])
    const old = this.cache.get(key)
    if (old && Date.now() < old.until) return old.promise
    const record = { until: Date.now() + 30_000, promise: null }
    record.promise = this.inspect_local(name, cfg).catch(() => false).then(ready => {
      record.until = Date.now() + (ready ? 300_000 : 30_000)
      return ready
    })
    this.cache.set(key, record)
    return record.promise
  }

  /** 参数 name/cfg：已校验的托管音频配置；使用与 LocalServiceLifecycle 相同的路径规则检查条件。 */
  async inspect_local(name, cfg) {
    if (name === 'llm') {
      // 与 start_stack.py 的默认解析保持一致：环境变量 > 同级/上两级 Gemma4 > 项目内 gemma。
      const sibling = join(this.project, '..', 'Gemma4')
      const releaseParent = join(this.project, '..', '..', 'Gemma4')
      const root = this.env.GEMMA_ROOT
        ? this.local_path(this.env.GEMMA_ROOT)
        : (existsSync(sibling) ? sibling : (existsSync(releaseParent) ? releaseParent : join(this.project, 'gemma')))
      const binary = this.local_path(this.env.GEMMA_BINARY || join(root, 'llama.cpp', 'build-ninja', 'bin', 'llama-server.exe'))
      if (!this.has_file(binary)) return false
      const wanted = String(cfg.model || '').trim()
      const dirs = [join(root, 'gemma4E4B', 'model'), join(root, 'model')]
      for (const dir of dirs) {
        try {
          const files = readdirSync(dir).filter(file => file.toLowerCase().endsWith('.gguf'))
          if (wanted && files.some(file => file.startsWith(wanted))) return true
          if (!wanted && files.some(file => file.toLowerCase().includes('gemma'))) return true
        } catch { /* 目录不存在就继续看下一个 */ }
      }
      return false
    }
    if (!this.has_file(join(this.project, 'services', 'LocalServiceLifecycle.py')) ||
      !this.has_file(join(this.project, 'services', 'AudioHttp.py'))) return false
    if (name === 'tts') {
      const python = this.local_path(this.env.BREEZE_PYTHON || 'D:\\breeze-tts\\.venv\\Scripts\\python.exe')
      const repo = this.local_path(this.env.BREEZE_REPO || 'D:\\breeze-tts')
      const ckpt = this.local_path(this.env.BREEZE_CKPT || join(this.project, 'models', 'breezeTts2'))
      if (!this.has_file(python) || !this.has_file(join(this.project, 'services', 'breezeTtsService.py')) ||
        !this.has_file(join(repo, 'breeze_infer', 'runtime.py')) ||
        !this.has_file(join(repo, 'models', 'fast_streaming.py')) || !this.breeze_model(ckpt)) return false
      return this.checkPython(python, ['torch', 'transformers', 'numpy', 'soundfile', 'safetensors'])
    }
    const python = [this.env.WHISPER_PYTHON, this.env.DSH_PYTHON, 'D:\\py39\\python.exe']
      .filter(Boolean).map(file => this.local_path(file)).find(file => this.has_file(file))
    if (!python || !this.has_file(join(this.project, 'services', 'whisperService.py')) || !this.whisper_model(cfg.model)) return false
    return this.checkPython(python, ['faster_whisper', 'ctranslate2', 'av'])
  }
}
