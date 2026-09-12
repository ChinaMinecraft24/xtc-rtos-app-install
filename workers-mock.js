/**
 * Workers 运行时模拟器：用 Node 内置 vm 直接加载 + 执行 src/index.js
 * 支持：import（改写为 require）、Request/Response、crypto.subtle
 * 不依赖 acorn / miniflare
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function installGlobals() {
  if (!globalThis.Request) {
    globalThis.Request = class Request {
      constructor(url, init = {}) { this.url = new URL(url); this.method = init.method || 'GET'; this._body = init.body }
      async json() { return JSON.parse(this._body) }
    }
  }
  if (!globalThis.Response) {
    globalThis.Response = class Response {
      constructor(body, init = {}) { this._body = body; this.status = init.status || 200; this._headers = init.headers || {} }
      async json() { return JSON.parse(this._body) }
      get status() { return this._status || 200 }
      set status(v) { this._status = v }
    }
  }
}

const moduleCache = new Map()

function runAsModule(absPath, contextify) {
  if (moduleCache.has(absPath)) return moduleCache.get(absPath).exports
  const code = readFileSync(absPath, 'utf8')
  // 把 ES import 改写为 CommonJS require（仅处理本工程相对路径）
  const transformed = code.replace(/import\s*\{([^}]+)\}\s*from\s*['"](\.\/[^'"]+)['"]/g, 'const {$1} = require("$2")')
  const moduleObj = { exports: {} }
  const context = contextify(moduleObj)
  const wrapper = `(function(exports, module, require){ ${transformed}\nreturn module.exports })`
  const fn = context.fn(wrapper, absPath)
  const exp = fn(moduleObj.exports, moduleObj, (id) => {
    if (id.startsWith('./')) {
      const target = resolve(absPath, '..', id)
      return runAsModule(target, contextify)
    }
    if (id === 'node:fs/promises' || id === 'node:fs') return { readFile: async () => '{"apps":[]}' }
    if (id === 'node:crypto') return require('crypto')
    return require(id)
  })
  moduleCache.set(absPath, { exports: exp })
  return exp
}

export async function loadWorker() {
  installGlobals()
  const main = resolve(process.cwd(), 'src/index.js')
  const sandbox = {
    exports: {}, module: { exports: {} }, require, console, URL, Buffer, Date, Math, JSON,
    parseInt, parseFloat, isNaN, String, Number, Boolean, Array, Object, RegExp, Error,
    setTimeout, clearTimeout, Promise, Map, Set, Symbol, Uint8Array, DataView, TextEncoder,
    crypto: globalThis.crypto, process, btoa, atob,
    import: async () => ({ default: {}, __esModule: true })
  }
  // 让 require 可用，且支持 vm 上下文
  const vm = await import('node:vm')
  const context = vm.createContext(sandbox)
  return runAsModule(main, (moduleObj) => ({
    fn: (code, fname) => new vm.Script(code, { filename: fname }).runInContext(context),
    exports: sandbox.exports, module: sandbox.module
  }))
}

export function createEnv(overrides = {}) {
  return {
    MANIFEST_SECRET: 'test-secret',
    GATE: JSON.stringify({
      enabled: true, rolloutPercent: 100, allowedAppIds: ['com.example.calculator'],
      models: [], minEngineVersion: '', requiredCapabilities: ['request.download', 'request.onDownloadComplete', 'file.writeArrayBuffer']
    }),
    APPS: JSON.stringify([{
      appId: 'com.example.calculator', packageName: 'com.example.calculator',
      displayVersion: '1.2.0', versionCode: 120, minStoreVersion: 100, minPlatformVersion: '1.0.0',
      models: ['Z6A', 'Z6S'], title: '计算器', summary: 't', permissions: ['0'],
      icon: { key: 'i', size: 100, sha256: '' }, rpk: { key: 'r', size: 100, sha256: 'x' },
      install: { strategy: 'unsupported', reason: 'unconfirmed' }
    }]),
    RPKS: undefined, AUDIT: undefined, ...overrides
  }
}

export async function dispatch(worker, env, url, init = {}) {
  return worker.fetch(new globalThis.Request(url, init), env)
}
