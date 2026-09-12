# 灰度策略上线流程

`install.strategy` 完全由云端 `GATE` 配置 + 设备指纹决定，端侧只读 `strategy` 字段。
**默认 `enabled: false`、`rolloutPercent: 0`**，任何型号未经验证都不会走运行时安装。

## 决策层级（任一不满足即降级 unsupported）

1. 全局开关 `enabled`
2. 应用白名单 `allowedAppIds`
3. 型号白名单 `models`
4. 引擎 / 系统版本门槛 `minEngineVersion` / `minPlatformVersion`
5. 比例灰度 `rolloutPercent`（按 deviceId 哈希稳定分流）
6. 能力白名单 `requiredCapabilities`（探测页上报）

## 上线步骤（每型号 ≥ 3 天观察期）

| 阶段 | rolloutPercent | 机型 | 观察指标 | 升级条件 |
|---|---|---|---|---|
| 0 默认 | 0 | — | 无 | 探测报告齐全 |
| 1 白名单 | 0 → 10 | Z6A（先选最旧支持的） | 下载成功率 >99%、无 security_event | 24h 无异常 |
| 2 扩展 | 10 → 50 | Z6A + Z6S | 内存 <48MB、无崩溃 | 48h 稳定 |
| 3 全量 | 50 → 100 | 全部白名单机型 | 覆盖安装/签名变化/冲突全绿 | 逐型号验收通过 |

## 变更方式

**方式 A：环境变量（推荐，原子切换）**
```bash
wrangler secret put GATE   # 或直接改 wrangler.toml [vars] GATE
wrangler deploy
```

**方式 B：运行时 KV（无需重新部署，秒级生效）**
在 `src/index.js` 的 `loadGateConfig` 中读取 `env.GATE_KV`，运维通过
`wrangler kv:put --namespace=... gate $(cat gate.json)` 实时变更。

## 回滚

- 任一指标异常 → `GATE.enabled = false` → 所有设备下次拉清单即降级为 `unsupported`
- 端侧已下载的 rpk 不会被自动删除，但不再触发安装流程（保持"发现+校验"基线能力）
- 已安装的应用由系统管理，与商店逻辑解耦，不受影响

## 可观测

- `GET /v1/gate/status`：查看当前 GATE 配置（仅运维网络可访问，生产建议加鉴权）
- `POST /v1/capability`：探测报告入库 KV，键 `cap:*`，可按型号聚合
- `/v1/manifest` 审计：键 `audit:*`，记录设备指纹摘要 + 命中策略

## 禁止事项

- ❌ 不在端侧硬编码任何型号白名单（一律服务端下发）
- ❌ 不做"先放行再观察"——`requiredCapabilities` 缺失必须拦截
- ❌ 不把灰度比例当 A/B 实验——同一 deviceId 哈希结果稳定，确保体验一致
- ❌ 不绕过签名校验，即使灰度全量也强制 sha256
