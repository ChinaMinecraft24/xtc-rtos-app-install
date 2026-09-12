/**
 * 小天才应用商店 · Cloudflare Worker（KV 版，不依赖 R2）
 * 端点：
 *   GET  /v1/manifest?device=<json>     版本清单（机型过滤 + 灰度策略 + HMAC 签名）
 *   GET  /v1/download/:appId/:version   KV 读取 rpk 二进制直接返回（10 分钟缓存）
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
  const list = (await loadApps(env))
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

/* ---------------- 2. 下载（KV 代理，替代 R2 签名 URL） ---------------- */
async function handleDownload(url, env) {
  const parts = url.pathname.replace('/v1/download/', '').split('/')
  const [appId, version] = parts
  if (!appId || !version) return json({ error: 'bad_path' }, 400)

  // KV key 约定：rpk:<appId>:<version>   （上传脚本按此写入）
  const key = `rpk:${appId}:${version}`
  const store = env.STORE
  if (!store) return json({ error: 'store_not_bound' }, 503)

  const metaRaw = await store.get('meta:' + key).catch(() => null)   // 元数据（size/sha256/etag）
  const bin = await store.get(key, { type: 'arrayBuffer' }).catch(() => null)
  if (!bin) return json({ error: 'object_not_found' }, 404)

  const meta = metaRaw ? safeJson(metaRaw) : {}
  const filename = `${appId}-${version}.rpk`

  return new Response(bin, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(meta.size || bin.byteLength),
      'Cache-Control': 'private, max-age=600',   // 10 分钟，近似原签名 URL 时效
      'Access-Control-Allow-Origin': '*',
      'X-RPK-Sha256': meta.sha256 || '',
      'X-RPK-Etag': meta.etag || '',
      'X-RPK-Download-Policy': 'kv-proxy'
    }
  })
}

/* ---------------- 3. 探测对象 ---------------- */
async function handleProbe(env) {
  const store = env.STORE
  if (store) {
    const obj = await store.get('probe:hello.bin', { type: 'arrayBuffer' }).catch(() => null)
    if (obj) {
      return new Response(obj, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(obj.byteLength) }
      })
    }
  }
  // 兜底：未上传探测对象时返回内存中的 1KB
  const buf = new Uint8Array(1024).fill(0x58)
  return new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1024' } })
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

async function loadGateConfig(env) {
  if (env.GATE) {
    try { return JSON.parse(env.GATE) } catch (_) {}
  }
  return {
    enabled: false,
    rolloutPercent: 0,
    allowedAppIds: [],
    models: [],
    minEngineVersion: '',
    requiredCapabilities: ['request.download', 'request.onDownloadComplete', 'file.writeArrayBuffer']
  }
}

/* 应用元数据：优先 KV（env.STORE get 'manifest'），其次 env.APPS，最后默认值 */
async function loadApps(env) {
  if (env.APPS) { return safeJson(env.APPS) }
  if (env.STORE) {
    const raw = await env.STORE.get('manifest').catch(() => null)
    if (raw) return safeJson(raw)
  }
  return defaultApps()
}

function safeJson(input) {
  try {
    const v = typeof input === 'string' ? JSON.parse(input) : input
    return (v && Array.isArray(v.apps)) ? v.apps : (Array.isArray(v) ? v : [])
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
      icon: { key: 'icon:com.example.calculator:120', size: 8421, sha256: '' },
      rpk: { key: 'rpk:com.example.calculator:120', size: 245760, sha256: '<由 upload-kv.js 回填>', etag: '' },
      permissions: ['0'],
      install: { strategy: 'unsupported', reason: 'runtime_install_unconfirmed', fallback: 'official_store_deeplink' },
      publishedAt: 1760000000
    }
  ]
}

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
    } catch (_) { /* fallback */ }
  }
  try {
    const { createHmac } = await import('node:crypto')
    const h = createHmac('sha256', secret).update(data).digest('hex')
    return { alg: 'hmac-sha256', keyId: '2026-01', value: h, issuedAt }
  } catch (_) {
    return { alg: 'hmac-sha256', keyId: '2026-01', value: 'dev-' + btoa(data).slice(0, 32), issuedAt }
  }
}
