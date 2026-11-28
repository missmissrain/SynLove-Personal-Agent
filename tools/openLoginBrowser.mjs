/**
 * 打开一个"登录用"浏览器窗口（有界面、持久 profile），给用户手动登录用。
 *
 * 特点：
 * - 用 tools/browserMcp 里的 playwright-core + 本机 Edge；
 * - profile 默认 runtime/browser-profile-media（视频下载用的登录态就落在这里）；
 * - 打开几个常用站点标签页，用户登录后直接关窗口即可，cookie 自动写回 profile。
 *
 * 用法：
 *   node tools\openLoginBrowser.mjs [--profile=...] [--sites=bilibili.com,xiaohongshu.com]
 */

import { chromium } from './browserMcp/node_modules/playwright-core/index.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const arg = (name) => {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}

const profile = arg('profile') ?? process.env.LOGIN_PROFILE ?? join(ROOT, 'runtime', 'browser-profile-media')
const sites = (arg('sites') ?? process.env.LOGIN_SITES ?? 'bilibili.com,xiaohongshu.com,www.douyin.com,weibo.com')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)

console.log('profile:', profile)
console.log('打开站点:', sites.join(', '))

const context = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 860 },
})

for (const site of sites) {
  const page = await context.newPage()
  await page.goto(`https://${site}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
}

context.on('close', () => {
  console.log('窗口已关闭，cookie 已写回 profile')
  process.exit(0)
})

console.log('窗口已打开：请完成登录后直接关闭浏览器窗口')
await new Promise(() => {})
