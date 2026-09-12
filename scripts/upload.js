#!/usr/bin/env node
/**
 * 上传 rpk + 图标到 R2，并输出可粘到 manifest 的元数据（size/sha256/etag）。
 * 用法：
 *   node scripts/upload.js --appId com.example.calc --version 120 \
 *        --rpk ./build/release.rpk --icon ./icon.png
 *
 * 前置：wrangler 已登录，且 wrangler.toml 中 RPKS 绑定正确。
 * 本脚本只负责「把包放上去 + 打印元数据」，不直接改线上 manifest——
 * 元数据请人工或 CI 写回 KV / APPS 环境变量。
 */
import { execSync } from 'node:child_process'
import { readFileSync, createHash } from 'node:fs'
import { resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const appId = req(args, 'appId')
const version = req(args, 'version')
const rpk = req(args, 'rpk')
const icon = args.icon

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(.+)/)
    if (m) o[m[1]] = argv[i + 1]
  }
  return o
}
function req(o, k) {
  if (!o[k]) { console.error(`缺少 --${k}`); process.exit(1) }
  return o[k]
}

const crypto = globalThis.crypto

async function main() {
  console.log('→ 计算本地 sha256 / 校验包规范...')
  const rpkMeta = await putObject(rpk, `apps/${appId}/${version}/rpk`, 'application/octet-stream')
  console.log(JSON.stringify(rpkMeta, null, 2))

  let iconMeta = null
  if (icon) {
    iconMeta = await putObject(icon, `apps/${appId}/${version}/icon.png`, 'image/png')
    console.log(JSON.stringify(iconMeta, null, 2))
  }

  console.log('\n✅ 上传完成。请将以下字段写回 manifest/apps.json：\n')
  console.log(JSON.stringify({
    appId, versionCode: Number(version),
    rpk: { key: `apps/${appId}/${version}/rpk`, size: rpkMeta.size, sha256: rpkMeta.sha256, etag: rpkMeta.etag },
    icon: iconMeta ? { key: `apps/${appId}/${version}/icon.png`, size: iconMeta.size, sha256: iconMeta.sha256 } : undefined
  }, null, 2))

  // 体积硬限制校验（官方：rpk ≤1MB，单文件 ≤10MB，图 ≤100KB）
  if (rpkMeta.size > 1 * 1024 * 1024) console.warn('⚠️ rpk 超过 1MB，可能无法安装！')
  if (iconMeta && iconMeta.size > 100 * 1024) console.warn('⚠️ 图标超过 100KB，会被拒绝下载！')
}

async function putObject(filePath, key, contentType) {
  const buf = readFileSync(resolve(filePath))
  const digest = createHash('sha256').update(buf).digest('hex')
  const tmp = `/tmp/xc-upload-${Date.now()}.bin`
  // 用 wrangler r2 上传（miniflare 本地与线上通用）
  const cmd = `wrangler r2 object put xc-rpk-store/${key} --file "${filePath}" --content-type "${contentType}"`
  console.log('→', cmd.replace(/"/g, ''))
  try { execSync(cmd, { stdio: 'inherit' }) } catch (e) { console.error('上传失败：', e.message); process.exit(1) }

  // etag 需通过 head 获取；本地 miniflare 可能没有，允许为空
  let etag = ''
  try {
    const head = execSync(`wrangler r2 object head xc-rpk-store/${key}`, { encoding: 'utf8' })
    const j = JSON.parse(head)
    etag = j.etag || j.ETag || ''
  } catch (_) { /* 忽略，端侧主要靠 sha256 */ }

  return { key, size: buf.byteLength, sha256: digest, etag }
}

main()
