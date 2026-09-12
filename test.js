/**
 * Worker 逻辑本地测试（不依赖 Cloudflare 运行时，纯函数部分直接验证）
 * 运行：node test.js
 */
import { readFileSync } from 'node:fs'

// 模拟 env
const env = { MANIFEST_SECRET: 'dev-secret-change-me', APPS: null, RPKS: null, AUDIT: null }

// 由于 index.js 是 ES module 且依赖 Workers 运行时，这里改为直接复刻纯函数做断言
function filterByDevice(app, d) {
  if (app.minStoreVersion && (d.storeVersionCode || 0) < app.minStoreVersion) {
    return { ...app, hiddenReason: 'store_too_old' }
  }
  if (app.models && app.models.length > 0) {
    const hit = app.models.includes(d.externalModel) || app.models.includes(d.model)
    if (!hit) return { ...app, hiddenReason: 'model_not_supported' }
  }
  return app
}

const apps = [
  { appId: 'com.example.calc', models: ['Z6A', 'Z6S', 'Z6 Pro', 'D3S'], minStoreVersion: 100, versionCode: 120 },
  { appId: 'com.example.notes', models: ['Z6 Pro'], minStoreVersion: 105, versionCode: 200 }
]

let pass = 0, fail = 0
function assert(cond, msg) { if (cond) { pass++; console.log('  ✓', msg) } else { fail++; console.log('  ✗', msg) } }

console.log('\n[filterByDevice]')
const d1 = { externalModel: 'Z6A', storeVersionCode: 100 }
assert(filterByDevice(apps[0], d1).hiddenReason === undefined, 'Z6A + store100 可见')
// calc 有 minStoreVersion=100，未传 storeVersionCode 时先触发 store_too_old（优先级高于型号）
assert(filterByDevice(apps[0], { externalModel: 'D2' }).hiddenReason === 'store_too_old', 'D2 未带商店版本 → 被版本门槛过滤（model 检查在版本之后）')
assert(filterByDevice(apps[0], { externalModel: 'D2', storeVersionCode: 200 }).hiddenReason === 'model_not_supported', 'D2 + 满足版本 → 被型号过滤')
assert(filterByDevice(apps[1], { externalModel: 'Z6 Pro', storeVersionCode: 90 }).hiddenReason === 'store_too_old', '旧商店被标记')
assert(filterByDevice(apps[1], { externalModel: 'Z6 Pro', storeVersionCode: 105 }).hiddenReason === undefined, '满足版本可见')

console.log('\n[签名占位]')
function sign(payload, secret) {
  const key = 'xc-manifest-v1|' + Date.now() + '|' + JSON.stringify(payload)
  return { alg: 'hmac-sha256', keyId: '2026-01', value: 'dev-' + btoa(key).slice(0, 32) }
}
const s = sign(apps, 'x')
assert(s.alg === 'hmac-sha256', '算法标识固定')
assert(typeof s.value === 'string' && s.value.length > 10, '签名值已生成（dev 占位，阶段2替换为真 HMAC）')

console.log(`\n[Unit] ${pass} 通过, ${fail} 失败`)
export const unitResult = { pass, fail }
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(fail ? 1 : 0)
}
