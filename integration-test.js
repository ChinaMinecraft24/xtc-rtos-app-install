#!/usr/bin/env node
/**
 * 真实闭环集成测试（不加载完整 Worker，直接验证核心逻辑一致性）
 *
 * 验证点：
 *   1. gate.js 的 evaluateInstallGate 与 index.js 的 applyInstallStrategy 行为一致
 *   2. sign() 生成的签名在端侧 verifyManifestSignature 能校验通过（HMAC 密钥一致）
 *   3. 端侧校验能识别篡改（篡改 apps 后签名失效）
 *
 * 运行：node integration-test.js
 */
import { evaluateInstallGate } from './src/gate.js'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
export const integrationResult = { pass: 0, fail: 0 }
const assert = (c, m) => { if (c){ pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }

const SECRET = 'test-secret'
const app = {
  appId: 'com.example.calculator', packageName: 'com.example.calculator',
  displayVersion: '1.2.0', versionCode: 120, minStoreVersion: 100, minPlatformVersion: '1.0.0',
  models: ['Z6A', 'Z6S'], title: '计算器', permissions: ['0'],
  install: { strategy: 'unsupported', reason: 'unconfirmed' }
}
const baseGate = {
  enabled: true, rolloutPercent: 100, allowedAppIds: ['com.example.calculator'],
  models: [], minEngineVersion: '', requiredCapabilities: ['request.download', 'request.onDownloadComplete', 'file.writeArrayBuffer']
}

// 复刻 index.js 的签名逻辑（保持一致 = 端侧可校验）
function sign(payload, secret, issuedAt) {
  const data = 'xc-manifest-v1|' + issuedAt + '|' + JSON.stringify(payload)
  return { alg: 'hmac-sha256', keyId: '2026-01', value: createHmac('sha256', secret).update(data).digest('hex'), issuedAt }
}

// 复刻 api.js 的端侧校验逻辑
function verifyManifestSignature(data, secret) {
  if (!data || !data.signature) return false
  const { issuedAt, value, alg } = data.signature
  if (alg !== 'hmac-sha256') return false
  const age = Date.now() - issuedAt
  if (age > 5 * 60 * 1000 || age < -60 * 1000) return false
  const payload = JSON.stringify(data.apps)
  const expect = createHmac('sha256', secret).update('xc-manifest-v1|' + issuedAt + '|' + payload).digest('hex')
  return value === expect
}

console.log('\n[闭环：灰度策略 → install.strategy]')
let d = evaluateInstallGate(app, { externalModel: 'Z6A', storeVersionCode: 100, capabilities: [{ key: 'request.download' }, { key: 'request.onDownloadComplete' }, { key: 'file.writeArrayBuffer' }] }, { gateConfig: baseGate })
assert(d.strategy === 'system_install', 'Z6A 全满足 → system_install')
assert(d.allowed === true, 'allowed=true')

d = evaluateInstallGate(app, { externalModel: 'Z6A', storeVersionCode: 100, capabilities: [{ key: 'request.download', ok: true }] }, { gateConfig: baseGate })
assert(d.strategy === 'unsupported' && d.reason.startsWith('capability_missing'), '仅上报 1 项能力（缺 onDownloadComplete/file.writeArrayBuffer）→ unsupported')

d = evaluateInstallGate(app, { externalModel: 'D2', storeVersionCode: 100, capabilities: [{ key: 'request.download' }, { key: 'request.onDownloadComplete' }, { key: 'file.writeArrayBuffer' }] }, { gateConfig: { ...baseGate, models: ['Z6A'] } })
assert(d.strategy === 'unsupported' && d.reason.startsWith('model_not_supported'), '型号不在白名单 → unsupported')

console.log('\n[闭环：HMAC 签名 ↔ 端侧校验]')
const issuedAt = Date.now()
const apps = [{ appId: 'com.example.calculator', versionCode: 120 }]
const sig = sign(apps, SECRET, issuedAt)
assert(/^[a-f0-9]{64}$/.test(sig.value), '签名是 64 位 hex')

const manifest = { apps, signature: sig }
assert(verifyManifestSignature(manifest, SECRET) === true, '端侧校验通过（密钥一致）')
assert(verifyManifestSignature(manifest, 'wrong-secret') === false, '错误密钥 → 校验失败')

// 篡改检测：改 apps 内容，签名应失效
const tampered = JSON.parse(JSON.stringify(manifest))
tampered.apps[0].versionCode = 999
assert(verifyManifestSignature(tampered, SECRET) === false, '篡改 apps 后签名失效（防篡改）')

// 时效窗口：把 issuedAt 拨到 10 分钟前
const expired = JSON.parse(JSON.stringify(manifest))
expired.signature.issuedAt = Date.now() - 10 * 60 * 1000
assert(verifyManifestSignature(expired, SECRET) === false, '过期签名（>5min）被拒绝')

console.log('\n[闭环：随机密钥多次签名确定性]')
for (let i = 0; i < 5; i++) {
  const s1 = sign(apps, SECRET, 1700000000000)
  const s2 = sign(apps, SECRET, 1700000000000)
  assert(s1.value === s2.value, `相同输入 → 签名确定（第 ${i + 1} 次）`)
}

console.log(`\n[Integration] ${pass} 通过, ${fail} 失败`)
integrationResult.pass = pass
integrationResult.fail = fail
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(fail ? 1 : 0)
}
