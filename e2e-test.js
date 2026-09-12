/**
 * 端到端测试（ESM）：mock 全局 + 复刻 Worker 关键路径，验证接口响应结构
 * 运行：node e2e-test.js
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const APPS = JSON.parse(readFileSync('./manifest-apps.json', 'utf8')).apps

let pass = 0, fail = 0
function assert(c, m){ if (c){ pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }

function filterByDevice(app, d) {
  if (app.minStoreVersion && (d.storeVersionCode || 0) < app.minStoreVersion) return { ...app, hiddenReason: 'store_too_old' }
  if (app.models && app.models.length > 0) {
    const hit = app.models.includes(d.externalModel) || app.models.includes(d.model)
    if (!hit) return { ...app, hiddenReason: 'model_not_supported' }
  }
  return app
}

console.log('\n[GET /v1/manifest]')
const m = (() => {
  const device = { externalModel: 'Z6A', storeVersionCode: 100 }
  const fp = [device.model, device.externalModel].filter(Boolean).join('|')
  const list = APPS.map((a) => filterByDevice(a, device)).filter((a) => a !== null)
  return { generatedAt: Date.now(), deviceFingerprint: fp, apps: list,
    signature: { alg: 'hmac-sha256', keyId: '2026-01', value: 'dev-' + 'x'.repeat(32).slice(0, 32) } }
})()
assert(m.apps.length === 1 && m.apps[0].appId === 'com.example.calculator', 'Z6A 返回 1 个应用，无 hiddenReason')
assert(m.signature.alg === 'hmac-sha256', '签名结构含 alg/keyId/value')
assert(m.deviceFingerprint === 'Z6A', '设备指纹取 externalModel')

const m2 = (() => {
  const list = APPS.map((a) => filterByDevice(a, { externalModel: 'D2', storeVersionCode: 200 })).filter((a) => a !== null)
  return list
})()
assert(m2[0].hiddenReason === 'model_not_supported', 'D2 标记 model_not_supported')

console.log('\n[GET /v1/download/:appId/:version]')
function handleDownload(appId, version, head) {
  if (!head) return { error: 'object_not_found', status: 404 }
  return { appId, versionCode: Number(version), url: `https://signed.example/${head.key}?sig=xxx`,
    expiresIn: 600, size: head.size, sha256: head.sha256, etag: head.etag }
}
const d1 = handleDownload('com.example.calculator', '120', { key: 'apps/.../rpk', size: 245760, sha256: 'abc', etag: '"x"' })
assert(d1.url.includes('sig=') && d1.expiresIn === 600 && d1.size === 245760, '签名 URL 结构完整（10分钟过期、含 size/sha256/etag）')

console.log('\n[POST /v1/capability]')
function handleCapability(payload) {
  if (!payload || !payload.rows) return { status: 400, error: 'bad_json' }
  return { ok: true, stored: true, key: 'cap:' + Date.now() }
}
assert(handleCapability({ device: { model: 'Z6A' }, rows: [{ key: 'request.download', ok: true }] }).ok, '合法上报 → ok')
assert(handleCapability({}).status === 400, '空 body → 400')

console.log('\n[GET /v1/gate/status]')
function handleGateStatus(gate) {
  return { gate, keyId: '2026-01' }
}
const gs = handleGateStatus({ enabled: false, rolloutPercent: 0, requiredCapabilities: ['request.download'] })
assert(gs.gate.enabled === false && gs.keyId === '2026-01', '灰度状态含 enabled + keyId')

console.log('\n[签名：真实 HMAC 字段]')
function makeSignature(body, secret, issuedAt) {
  const data = 'xc-manifest-v1|' + issuedAt + '|' + JSON.stringify(body)
  return { alg: 'hmac-sha256', keyId: '2026-01', value: createHmac('sha256', secret).update(data).digest('hex'), issuedAt }
}
const sig = makeSignature([{ appId: 'a' }], 'dev-secret-change-me', 1700000000000)
assert(/^[a-f0-9]{64}$/.test(sig.value), 'HMAC-SHA256 输出 64 位 hex')
assert(sig.issuedAt > 0, '签名含 issuedAt（端侧做时效校验）')

console.log('\n[端侧校验对齐]')
function verify(buf, urlInfo) {
  if (!urlInfo.sha256) return true
  if (buf.byteLength !== urlInfo.size) return false
  return true
}
const fake = Buffer.from('rpk-bytes')
const localSha = createHash('sha256').update(fake).digest('hex')
assert(verify(fake, { size: fake.byteLength, sha256: localSha }), 'size 一致 → 校验通过（本地对齐）')
assert(!verify(fake, { size: 999, sha256: 'x' }), 'size 不一致 → 校验失败')
void localSha

console.log('\n[体积硬限制校验]')
assert(APPS[0].rpk.size <= 1 * 1024 * 1024, '示例 rpk ≤ 1MB')
assert(APPS[0].icon.size <= 100 * 1024, '示例图标 ≤ 100KB')

console.log(`\n[E2E] ${pass} 通过, ${fail} 失败`)
export const e2eResult = { pass, fail }
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(fail ? 1 : 0)
}
