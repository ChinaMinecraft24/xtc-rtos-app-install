/**
 * 小天才应用商店 · CloudFlare Worker
 * 端点：
 *   GET  /v1/manifest?device=<json>     版本清单（机型过滤 + 灰度策略 + HMAC 签名）
 *   GET  /v1/download/:appId/:version   R2 短期签名 URL（10 分钟有效）
 *   GET  /v1/probe/hello.bin            探测用固定 1KB 对象
 *   POST /v1/capability                 上报探测页 CAPABILITY_REPORT → KV 审计
 *   GET  /v1/gate/status                运维查看当前灰度配置与命中情况
 */
import { evaluateInstallGate } from './gate.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname
    try {
      if (path === '/v1/manifest') return await handleManifest(request, env)
      if (path.startsWith('/v1/download/')) return await handleDownload(url, env)
      if (path === '/v1/probe/hello.bin') return await handleProbe(env)
      if (path === '/v1/capability' && request.method === 'POST') return await handleCapability(request, env)
      if (path === '/v1/gate/status') {
        const gate = await loadGateConfig(env)
        return json({ gate, keyId: '2026-01' }, 200, { 'Access-Control-Allow-Origin': '*' })
      }
      if (path === '/' || path === '/health') return json({ ok: true, service: 'xc-store-api' })
      return json({ error: 'not_found' }, 404)
    } catch (e) {
      return json({ error: 'server_error', message: e.message }, 500)
    }
  }
}

/* ---------------- 1. 清单 ---------------- */
async function handleManifest(request, env) {
  const deviceRaw = new URL(request.url).searchParams.get('device') || '{}'
  let device = {}
  try { device = JSON.parse(deviceRaw) } catch (_) { device = {} }

  const fp = [
    device.brand, device.manufacturer, device.model, device.externalModel,
    device.product, device.windowWidth + 'x' + device.windowHeight
  ].filter(Boolean).join('|')

  const gateConfig = await loadGateConfig(env)
  const list = (env.APPS ? JSON.parse(env.APPS) : await loadApps(env))
    .map((app) => applyInstallStrategy(app, device, gateConfig))
    .map((app) => filterByDevice(app, device))
    .filter((app) => app !== null)

  const body = {
    generatedAt: Date.now(),
    serverTime: Math.floor(Date.now() / 1000),
    deviceFingerprint: fp,
    store: { minVersionCode: 100, forceUpgrade: false },
    apps: list,
    signature: await sign(list, env.MANIFEST_SECRET || 'dev-secret-change-me')
  }

  if (env.AUDIT) {
    env.AUDIT.put('audit:' + Date.now() + ':' + Math.random().toString(36).slice(2),
      JSON.stringify({ t: Date.now(), fp, count: list.length, gate: gateConfig.enabled })).catch(() => {})
  }

  return json(body, 200, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
}

/* 按机型 / 引擎版本 / 商店版本过滤；install 策略完全由云端下发 */
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

/* 灰度：决定该设备对该应用能否走「运行时安装」 */
function applyInstallStrategy(app, device, gateConfig) {
  const decision = evaluateInstallGate(app, device, { gateConfig })
  return {
    ...app,
    install: {
      ...(app.install || {}),
      strategy: decision.strategy,
      reason: decision.reason,
      _reasons: decision.reasons
    }
  }
}

/* ---------------- 2. 签名下载 URL ---------------- */
async function handleDownload(url, env) {
  const parts = url.pathname.replace('/v1/download/', '').split('/')
  const [appId, version] = parts
  if (!appId || !version) return json({ error: 'bad_path' }, 400)

  const key = `apps/${appId}/${version}/rpk`
  const bucket = env.RPKS
  if (!bucket) return json({ error: 'r2_not_bound' }, 503)

  const head = await bucket.head(key).catch(() => null)
  if (!head) return json({ error: 'object_not_found' }, 404)

  const signed = await bucket.createSignedUrl(key, {
    expiresIn: 60 * 10,
    method: 'GET'
  }).catch(() => null)
  if (!signed) return json({ error: 'sign_failed' }, 500)

  return json({
    appId, versionCode: Number(version),
    url: signed,
    expiresIn: 600,
    size: head.size,
    sha256: head.checksums?.sha256 || head.customMetadata?.sha256 || '',
    etag: head.etag || '',
    downloadPolicy: 'signed-url'
  })
}

/* ---------------- 3. 探测对象 ---------------- */
async function handleProbe(env) {
  const bucket = env.RPKS
  if (!bucket) {
    const buf = new Uint8Array(1024).fill(0x58)
    return new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1024' } })
  }
  const obj = await bucket.get('probe/hello.bin').catch(() => null)
  if (!obj) return new Response('not uploaded', { status: 404 })
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream' } })
}

/* ---------------- 4. 能力上报 ---------------- */
async function handleCapability(request, env) {
  let payload = {}
  try { payload = await request.json() } catch (_) { return json({ error: 'bad_json' }, 400) }
  const key = 'cap:' + Date.now() + ':' + Math.random().toString(36).slice(2)
  if (env.AUDIT) {
    await env.AUDIT.put(key, JSON.stringify({ t: Date.now(), device: payload.device, rows: payload.rows })).catch(() => {})
  }
  return json({ ok: true, stored: !!env.AUDIT })
}

/* ---------------- 工具 ---------------- */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  })
}

/* 灰度配置：线上由 env.GATE（KV / 环境变量）注入；本地走默认值 */
async function loadGateConfig(env) {
  if (env.GATE) {
    try { return JSON.parse(env.GATE) } catch (_) {}
  }
  return {
    enabled: false,                 // ★ 默认关闭，逐型号验证后开启
    rolloutPercent: 0,
    allowedAppIds: [],
    models: [],
    minEngineVersion: '',
    requiredCapabilities: ['request.download', 'request.onDownloadComplete', 'file.writeArrayBuffer']
  }
}

/* 应用元数据加载：本地读 manifest-apps.json；线上建议放 KV / D1，用 env.APPS 注入 */
async function loadApps(env) {
  if (env.APPS) { return JSON.parse(env.APPS) }
  if (typeof EdgeRuntime !== 'undefined' || (env && env.AUDIT)) {
    return defaultApps()
  }
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile('./manifest-apps.json', 'utf8')
    return JSON.parse(raw).apps
  } catch (_) {
    return defaultApps()
  }
}

function defaultApps() {
  return [
    {
      appId: 'com.example.calculator',
      packageName: 'com.example.calculator',
      displayVersion: '1.2.0',
      versionCode: 120,
      minStoreVersion: 100,
      minPlatformVersion: '1.0.0',
      models: ['Z6A', 'Z6S', 'Z6 Pro', 'D3S'],
      title: '计算器',
      summary: '适配 240×240 的极简计算器',
      icon: { key: 'apps/com.example.calculator/120/icon.png', size: 8421, sha256: '' },
      rpk: { key: 'apps/com.example.calculator/120/rpk', size: 245760, sha256: '<由 upload.js 回填>', etag: '' },
      permissions: ['0'],
      install: { strategy: 'unsupported', reason: 'runtime_install_unconfirmed', fallback: 'official_store_deeplink' },
      publishedAt: 1760000000
    }
  ]
}

/* 清单级 HMAC 签名：端侧校验 field + 时间戳，防篡改 */
async function sign(payload, secret) {
  const body = JSON.stringify(payload)
  const issuedAt = Date.now()
  const data = 'xc-manifest-v1|' + issuedAt + '|' + body
  const crypto = globalThis.crypto
  if (crypto && crypto.subtle) {
    try {
      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
      const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
      return { alg: 'hmac-sha256', keyId: '2026-01', value: hex, issuedAt }
    } catch (_) { /* 降级到 Node crypto（本地 wrangler dev 环境） */ }
  }
  // Node 环境 fallback（Workers 生产环境不会走到这里）
  try {
    const { createHmac } = await import('node:crypto')
    const h = createHmac('sha256', secret).update(data).digest('hex')
    return { alg: 'hmac-sha256', keyId: '2026-01', value: h, issuedAt }
  } catch (_) {
    return { alg: 'hmac-sha256', keyId: '2026-01', value: 'dev-' + btoa(data).slice(0, 32), issuedAt }
  }
}
