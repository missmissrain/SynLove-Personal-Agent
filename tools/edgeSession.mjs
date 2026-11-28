/**
 * 从本机浏览器会话里读取某站点 cookie，导出成 Netscape 格式给 yt-dlp 用。
 *
 * 为什么不直接用 yt-dlp --cookies-from-browser edge：
 * Edge 156 的 cookie 库被新加密（App-Bound）且运行时被锁，yt-dlp 会报
 * "Could not copy Chrome cookie database"。Playwright 通过 CDP 直接读 cookie，
 * 不需要解密，稳定得多。
 *
 * 用法：
 *   node tools\edgeSession.mjs --check --domain bilibili.com --out runtime/cookies/bilibili.txt
 *       只检查（无窗口）；登录态有效 → 导出并 exit 0，需要登录 → exit 2
 *   node tools\edgeSession.mjs --domain bilibili.com --url https://www.bilibili.com/ --out ...
 *       有界面打开，等用户登录（默认最多 300 秒），登录后导出
 */

import { chromium } from './browserMcp/node_modules/playwright-core/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 各站点的"已登录"判定 cookie（命中任意一个即认为登录态有效）。 */
const MARKERS = {
  'bilibili.com': ['SESSDATA'],
  'xiaohongshu.com': ['web_session'],
  'douyin.com': ['sessionid', 'sessionid_ss'],
  'youtube.com': ['SAPISID', 'LOGIN_INFO'],
  'weibo.com': ['SUB'],
  'zhihu.com': ['z_c0'],
}

const arg = (name) => {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}
const flag = (name) => process.argv.includes(`--${name}`)

const domain = arg('domain')
const url = arg('url') ?? `https://${domain}/`
const out = arg('out') ?? join(ROOT, 'runtime', 'cookies', `${domain}.txt`)
const timeoutSeconds = Number(arg('timeout') ?? '300')
const checkOnly = flag('check')

if (domain === undefined) {
  console.error('必须给 --domain')
  process.exit(3)
}

/** 判定 cookie 里有没有登录标记。 */
function loggedIn(cookies) {
  const markers = MARKERS[domain] ?? []
  const names = new Set(cookies.map(item => item.name))
  if (markers.length > 0) return markers.some(name => names.has(name))
  return cookies.filter(item => /sess|session|token|auth/i.test(item.name)).length > 0
}

/** 写 Netscape cookie 文件。 */
function writeNetscape(cookies, path) {
  mkdirSync(dirname(path), { recursive: true })
  const lines = ['# Netscape HTTP Cookie File']
  for (const item of cookies) {
    const domainField = item.domain.startsWith('.') ? item.domain : `.${item.domain}`
    lines.push([
      domainField,
      'TRUE',
      item.path ?? '/',
      item.secure ? 'TRUE' : 'FALSE',
      Math.floor(item.expires && item.expires > 0 ? item.expires : 0),
      item.name,
      item.value,
    ].join('\t'))
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return cookies.length
}

const profile = join(ROOT, 'runtime', 'browser-profile-media')

const context = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: checkOnly,
  viewport: { width: 1280, height: 860 },
})
const page = context.pages()[0] ?? await context.newPage()

try {
  if (!checkOnly) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})

  const deadline = Date.now() + (checkOnly ? 0 : timeoutSeconds * 1000)
  let cookies = await context.cookies()
  let ok = loggedIn(cookies)

  while (!ok && Date.now() < deadline) {
    console.log('等待登录…（窗口已打开，请在浏览器里完成登录）')
    await new Promise(resolve => setTimeout(resolve, 3000))
    cookies = await context.cookies()
    ok = loggedIn(cookies)
  }

  if (!ok) {
    console.log(`NEED_LOGIN ${domain}`)
    if (!checkOnly) console.log('登录窗口将在几秒后关闭：请重新运行命令，并在窗口里完成登录。')
    process.exitCode = 2
  } else {
    const count = writeNetscape(cookies.filter(item => item.domain.includes(domain)), out)
    console.log(`OK cookies=${count} -> ${out}`)
    process.exitCode = 0
  }
} finally {
  // 无论成功失败都关窗：不关的话 node 进程会挂住，调用方会一直等
  await context.close().catch(() => {})
}
