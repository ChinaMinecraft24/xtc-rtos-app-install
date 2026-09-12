#!/usr/bin/env node
/* 用法：node scripts/upload-kv.js <appId> <versionCode> <rpkPath> [iconPath] */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [appId, version, rpkPath, iconPath] = process.argv.slice(2)
if (!appId || !version || !rpkPath) {
  console.error('用法: node upload-kv.js <appId> <version> <rpkPath> [iconPath]')
  process.exit(1)
}

const rpkBuf = readFileSync(rpkPath)
const sha256 = createHash('sha256').update(rpkBuf).digest('hex')
const size = rpkBuf.byteLength
const rpkKey = `rpk:${appId}:${version}`
const metaKey = `meta:${rpkKey}`

function put(key, value, isFile) {
  const cmd = isFile
    ? `npx wrangler kv key put --binding=STORE "${key}" --path="${value}" --remote`
    : `npx wrangler kv key put --binding=STORE "${key}" '${value}' --remote`
  console.log('→', key)
  execSync(cmd, { stdio: 'inherit' })
}

// 1. rpk 二进制
put(rpkKey, rpkPath, true)

// 2. 元数据（手表端下载响应里的 size/sha256 来自这里）
put(metaKey, JSON.stringify({ size, sha256, etag: '' }))

// 3. 图标（可选）
if (iconPath) {
  put(`icon:${appId}:${version}`, iconPath, true)
}

// 4. 更新 manifest（追加/更新该 app）
console.log('\n⚠️  记得把以下信息合并进 KV 的 "manifest" key：')
console.log(JSON.stringify({
  appId, packageName: appId, displayVersion: version, versionCode: Number(version),
  rpk: { key: rpkKey, size, sha256, etag: '' }
}, null, 2))

console.log('\n✅ 上传完成。下一步：更新 KV 中的 manifest 清单。')
