/**
 * 灰度引擎单元测试（ESM）
 * 运行：node test-gate.js
 */
import { evaluateInstallGate } from './src/gate.js'

let pass = 0, fail = 0
const assert = (c, m) => { if (c){ pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }

const app = {
  appId: 'com.example.calc',
  minPlatformVersion: '1.0.0',
  install: { models: ['Z6A', 'Z6S'], allowedAppIds: ['com.example.calc'] }
}
const cfg = {
  enabled: true, rolloutPercent: 100, allowedAppIds: ['com.example.calc'],
  models: [], minEngineVersion: '', requiredCapabilities: ['request.download', 'request.onDownloadComplete', 'file.writeArrayBuffer']
}

console.log('\n[灰度：允许]')
let r = evaluateInstallGate(app, { externalModel: 'Z6A', capabilities: [{ key: 'request.download' }, { key: 'request.onDownloadComplete' }, { key: 'file.writeArrayBuffer' }] }, { gateConfig: cfg })
assert(r.allowed && r.strategy === 'system_install', '全部满足 → system_install')

console.log('\n[灰度：全局关闭]')
r = evaluateInstallGate(app, { externalModel: 'Z6A', capabilities: [{ key: 'request.download' }] }, { gateConfig: { ...cfg, enabled: false } })
assert(!r.allowed && r.reason === 'gate_disabled', 'enabled=false → 降级，reason=gate_disabled')

console.log('\n[灰度：型号不匹配]')
r = evaluateInstallGate(app, { externalModel: 'D2', capabilities: [{ key: 'request.download' }] }, { gateConfig: cfg })
assert(!r.allowed && r.reason.startsWith('model_not_supported'), 'D2 → model_not_supported')

console.log('\n[灰度：能力缺失]')
r = evaluateInstallGate(app, { externalModel: 'Z6A', capabilities: [{ key: 'request.download' }] }, { gateConfig: cfg })
assert(!r.allowed && r.reason.startsWith('capability_missing'), '缺 onDownloadComplete/file.writeArrayBuffer → capability_missing')

console.log('\n[灰度：比例分流稳定性]')
const cfg50 = { ...cfg, rolloutPercent: 50 }
const d1 = { externalModel: 'Z6A', deviceId: 'DEV-001', capabilities: [{ key: 'request.download' }, { key: 'request.onDownloadComplete' }, { key: 'file.writeArrayBuffer' }] }
const d2 = { externalModel: 'Z6A', deviceId: 'DEV-002', capabilities: d1.capabilities }
const r1 = evaluateInstallGate(app, d1, { gateConfig: cfg50 })
const r2 = evaluateInstallGate(app, d2, { gateConfig: cfg50 })
// DEV-001 与 DEV-002 应稳定落在各自桶（一个进一个不进都正常，关键是多次一致）
const r1b = evaluateInstallGate(app, d1, { gateConfig: cfg50 })
assert(r1.allowed === r1b.allowed, '同一 deviceId 多次判定结果一致（稳定分流）')

console.log('\n[灰度：应用白名单]')
r = evaluateInstallGate(app, { externalModel: 'Z6A', capabilities: [{ key: 'request.download' }, { key: 'request.onDownloadComplete' }, { key: 'file.writeArrayBuffer' }] }, { gateConfig: { ...cfg, allowedAppIds: ['com.example.other'] } })
assert(!r.allowed && r.reason === 'app_not_whitelisted', '非白名单应用 → app_not_whitelisted')

console.log(`\n[Gate] ${pass} 通过, ${fail} 失败`)
export const gatePass = pass
if (import.meta.url === `file://${process.argv[1]}`) process.exit(fail ? 1 : 0)
