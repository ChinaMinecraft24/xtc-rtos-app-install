# 部署清单 & 真机验收

## 一、从零部署（约 30 分钟）

### 云端
- [ ] `npm i -g wrangler && wrangler login`
- [ ] `wrangler r2 bucket create xc-rpk-store`
- [ ] 编辑 `wrangler.toml`：把 `kv_namespaces` 的 `id` 换成 `wrangler kv:namespace create AUDIT` 的返回值（审计可选）
- [ ] 改 `MANIFEST_SECRET` 为随机强密钥（端侧 `api.js` 用同一值）
- [ ] `node test.js` 全绿
- [ ] `wrangler dev` → 三接口本地跑通（见 README）
- [ ] 配置自定义域名 + HTTPS（手表端要求 https）
- [ ] `wrangler deploy` → 记下 Worker URL，更新 `api.js` 的 `BASE`
- [ ] 在 Cloudflare 控制台设 R2 访问策略（默认私有，仅 Worker 可读写）

### 端侧（手表）
- [ ] 用快应用 IDE + 小天才插件打开 `xc-watch-app`
- [ ] 替换 `api.js` 中 `BASE` 为你的 Worker 域名
- [ ] `manifest.json` 的包名/图标换成自有（图标 86×86、76×76）
- [ ] `npm run release` 打 release rpk（**勿含 .map，单编译文件 ≤200KB**）
- [ ] 绑定号加白名单 → 上传到指定手表 → 真机安装

## 二、真机验收（每型号 ≥ 5 次，记录型号/系统版本/网络/失败码/复现步骤）

| 类别 | 用例 | 通过标准 | ✅ |
|---|---|---|---|
| 下载 | 1KB / 100KB / 10MB；弱网中断；签名 URL 过期 | 成功/取消/重试可解释，文件可读 | |
| 进度 | 枚举 request 与全局对象所有回调 | 至少一种稳定连续返回 received/total | |
| Range | Range: bytes=0-99；部分下载后恢复 | 服务端 access log 确认透传；sha256 正确 | |
| 文件 | writeArrayBuffer / move / get / delete | rpk 完整保存、可移动、可清理 | |
| 包查询 | hasInstalled / getInfo | 明确支持或不支持，不静默空对象 | |
| 安装 | pkg.install；成功/失败/重复/升级 | 桌面有图标、重启保留、卸载消失 | |
| 任意包 | 自有/合作/伪造包名/错误签名 | 系统明确接受或拒绝，不静默降级 | |
| 性能 | 20 应用列表 + 图标 + 队列 | 内存 < 48MB，无长连接，轮询 ≥3s | |
| 签名 | 篡改 manifest / sha256 不匹配 / 过期签名 | 被拒绝并记录 security_event | |

## 三、判定规则（分层，不可跳步）

1. 模块可导入 ≠ 方法可用
2. 方法是函数 ≠ 运行时生效
3. 回调返回成功 ≠ 包完成注册
4. 桌面出现图标且可启动 = **弱证据**
5. 覆盖安装 / 签名变化 / 包名冲突 / 权限变更 / 网络中断 全通过 = **该型号可用**

## 四、上线前检查

- [ ] rpk ≤ 1MB、单文件 ≤ 10MB、图标 ≤ 100KB 且缓存 ≤ 70 张
- [ ] HTTP 并发 ≤ 15、轮询 ≥ 3s、内存 ≤ 48MB
- [ ] 所有下载走短期签名 URL，R2 bucket 私有
- [ ] 清单含签名 + 时间戳，端侧校验时效窗口
- [ ] `install.strategy` 默认 `unsupported`，逐型号服务端开关
- [ ] 无热更新 / eval / 动态 import / 远程 ux
- [ ] 取消可清理临时文件、重试有上限（6/10）
- [ ] 审计日志可查（设备指纹 + 下载/安装/失败事件）
