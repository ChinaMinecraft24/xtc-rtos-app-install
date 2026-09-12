/**
 * 灰度策略引擎：分层判定「运行时安装」是否对该设备开放
 *
 * 层级（任一不满足即降级为 unsupported）：
 *   1. 全局开关 enabled
 *   2. 应用级白名单（app.install.allowedAppIds）
 *   3. 型号白名单（app.install.models / 全局 models）
 *   4. 引擎/系统版本门槛（minEngineVersion / minPlatformVersion）
 *   5. 比例灰度（按 deviceId 哈希稳定分流，同一设备始终一致）
 *   6. 能力白名单（探测页上报的 CAPABILITY_REPORT 中必须存在的关键方法）
 */
export function evaluateInstallGate(app, device, options = {}) {
  const cfg = options.gateConfig || defaultGateConfig()
  const reasons = []

  // 1) 全局开关
  if (!cfg.enabled) reasons.push('gate_disabled')

  // 2) 应用白名单
  if (cfg.allowedAppIds && cfg.allowedAppIds.length > 0) {
    if (!cfg.allowedAppIds.includes(app.appId)) reasons.push('app_not_whitelisted')
  }

  // 3) 型号
  const models = app.install && app.install.models ? app.install.models : cfg.models
  if (models && models.length > 0) {
    const hit = models.includes(device.externalModel) || models.includes(device.model)
    if (!hit) reasons.push('model_not_supported:' + (device.externalModel || device.model))
  }

  // 4) 版本门槛
  if (cfg.minEngineVersion && (device.engineVersion || '') < cfg.minEngineVersion) {
    reasons.push('engine_too_old:' + device.engineVersion)
  }
  if (app.minPlatformVersion && (device.platformVersion || device.osVersion || '') < app.minPlatformVersion) {
    reasons.push('platform_too_old:' + app.minPlatformVersion)
  }

  // 5) 比例灰度（稳定分流）
  if (cfg.rolloutPercent < 100) {
    const hash = stableHash(device.deviceId || device.externalModel || 'unknown')
    const bucket = hash % 100
    if (bucket >= cfg.rolloutPercent) reasons.push('rollout:' + bucket + '/' + cfg.rolloutPercent)
  }

  // 6) 能力白名单：探测报告必须包含关键方法
  if (cfg.requiredCapabilities && cfg.requiredCapabilities.length > 0 && Array.isArray(device.capabilities) && device.capabilities.length > 0) {
    // 只统计 ok=true 的能力（探测页确认「方法存在」）；空上报不拦截，便于早期观察
    const caps = device.capabilities.filter((c) => c && c.ok === true).map((c) => c.key)
    const missing = cfg.requiredCapabilities.filter((k) => !caps.includes(k))
    if (missing.length > 0) reasons.push('capability_missing:' + missing.join(','))
  }

  const allowed = reasons.length === 0
  return {
    allowed,
    strategy: allowed ? 'system_install' : 'unsupported',
    reason: allowed ? 'ok' : reasons[0],
    reasons,
    evaluatedAt: Date.now()
  }
}

/* 稳定哈希：同一 deviceId 永远落在同一桶，便于灰度可逆 */
function stableHash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100)
}

function defaultGateConfig() {
  return {
    enabled: false,                    // ★ 默认关闭，逐型号验证后开启
    rolloutPercent: 0,                 // 0-100，先 10% 观察
    allowedAppIds: [],                 // 空 = 不限制应用
    models: [],                        // 空 = 不限制型号
    minEngineVersion: '',
    requiredCapabilities: ['request.download', 'request.onDownloadComplete', 'file.writeArrayBuffer']
  }
}
