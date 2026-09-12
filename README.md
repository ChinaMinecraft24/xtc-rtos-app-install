# 小天才应用商店 · 阶段 1 + 灰度引擎

云端：Cloudflare R2 + Worker
端侧：小天才 JS 框架（240×240 手表应用商店）

## 架构

```
R2 (rpk/图标)  →  Worker (清单 / HMAC签名 / 灰度引擎 / 审计 / 短期URL)
   │                    ↓ install.strategy（由 GATE 配置 + 设备指纹决定）
   └──────────────── 手表商店 App
        device.getInfo → GET /v1/manifest → [appId, versionCode, sha256, install]
        → GET /v1/download/:appId/:version → signed URL → request.download
        → internal://cache → sha256 校验 → internal://files
        → system_install（灰度放行）/ unsupported（官方分发降级）
        ↕ 探测报告
        POST /v1/capability ← 探测页 CAPABILITY_REPORT
```

**关键设计**：端侧只读 `install.strategy` 字段，是否允许运行时安装 **100% 由云端决定**，
可随时通过 `GATE` 环境变量 / KV 秒级关闭，无需重新发版。

## 目录

```
xc-store-api/                 云端 Worker
  src/index.js                   5 个端点 + HMAC 签名
  src/gate.js                    ★灰度策略引擎（分层判定）
  scripts/upload.js              上传 rpk/图标 → 输出 size/sha256/etag
  manifest-apps.json            应用元数据（upload.js 回填 sha256）
  wrangler.toml                 生产绑定
  wrangler.local.toml            本地开发绑定（含 GATE 示例）
  test.js                        单元测试
  test-gate.js                   ★灰度引擎测试
  e2e-test.js                    端到端测试
  test-all.js                    统一入口（单元 + E2E + 灰度）
  GRAY-PLAN.md                   ★灰度上线流程 / 回滚 / 可观测
xc-watch-app/                 手表端
  manifest.json
  app.ux
  common/api.js                  设备指纹 / 清单 / HMAC校验 / URL白名单（CONFIG 集中）
  common/download-store.js       下载状态机 + 重试 + sha256 校验 + 持久化
  common/crypto.js               ★sha256（crypto.subtle 优先 + crypto-es fallback）
  pages/home.ux                  列表 + 版本比对 + onShow 轮询 + 能力上报
  pages/detail.ux                下载/进度/失败重试/官方分发降级
  pages/detect.ux                ★能力探测页（分层判定 + 报告上报）
```

## 快速开始

```bash
cd xc-store-api
npm install          # wrangler + acorn
npx wrangler login
npx wrangler r2 bucket create xc-rpk-store
cp wrangler.local.toml wrangler.local.toml.bak   # 按需调整 GATE
npx wrangler dev      # http://localhost:8787
```

运行全部测试：
```bash
npm test              # = node test-all.js
```

测试清单：
```bash
curl 'http://localhost:8787/v1/manifest?device={"externalModel":"Z6A","storeVersionCode":100}'
curl 'http://localhost:8787/v1/gate/status'
curl -X POST http://localhost:8787/v1/capability -H 'Content-Type: application/json' \
     -d '{"device":{"model":"Z6A"},"rows":[{"key":"request.download","ok":true}]}'
```

部署：
```bash
npx wrangler deploy
# 灰度配置（推荐用 secret，避免提交到仓库）
echo '{"enabled":false,"rolloutPercent":0,...}' | npx wrangler secret put GATE
```

## 灰度策略（详见 GRAY-PLAN.md）

默认全关，逐型号验证后按 `0 → 10 → 50 → 100` 分阶段放量，每阶段 ≥24h 观察。
判定标准（**不可跳步**）：
1. 模块可导入 ≠ 方法可用
2. 方法是函数 ≠ 运行时生效
3. 回调返回成功 ≠ 包完成注册
4. 桌面出现图标且可启动 = **弱证据**
5. 覆盖安装 / 签名变化 / 包名冲突 / 权限变更 / 网络中断 全通过 = **该型号可用**

## 红线

- 不把 download 完成报成安装成功
- 不做热更新 / eval / 动态 import / 远程 ux
- R2 私有 + 短期签名 URL（10 分钟）
- 清单 HMAC-SHA256 + 时间戳防重放
- 端侧无型号白名单硬编码，一律服务端下发
- 资源限制：单图 ≤100KB、缓存 ≤70、单文件 ≤10MB、rpk ≤1MB、HTTP ≤15、轮询 ≥3s、内存 ≤48MB

## 已实现 / 待补齐

- [x] HMAC-SHA256 真签名（Workers crypto.subtle + Node fallback）
- [x] 端侧 sha256 校验（crypto.subtle 优先 + crypto-es fallback）
- [x] 灰度引擎（6 层判定 + 稳定分流）
- [x] 探测报告上报 + 审计 KV
- [ ] 图标通过 getDownloadUrl 下发（省内存）
- [ ] 任务队列并发上限 3 + 全局 HTTP ≤15 限流
- [ ] GATE 改为 KV 运行时读写（无需重新部署即可变更）
