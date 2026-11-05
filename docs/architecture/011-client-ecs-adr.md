# ADR 011: 纯客户端、Surface Agent Host 与自有 ECS 网关

> **状态**：拓扑与产品边界已定；WSS 端到端协议仍待独立安全审查。账户签名根按信任模型留在 ECS；本文不声称抵抗 ECS-root compromise，也不批准生产 WSS 密码学、部署或迁移。
> **关联**：[Plan 011](../../plans/011-client-ecs-resilience.md)；Cloudflare 账户 API 改造须与 Plan 002 串行协调。

## 背景

用户要在 Mac、Windows ARM64 和 Android 上使用纯客户端；Agent/Provider 常驻在既有 Surface Pro 7，而不是客户端或 ECS。客户端可作为远端设备能力端点：桌面按一次明确授权开放当前登录用户权限内的文件和终端。阿里云上海 ECS 只承载轻量账户服务与公网路由。公网数据主路径使用 TLS/WSS 443；账户服务不存聊天、命令或附件。

用户确认的运行条件：Surface Pro 7、Windows 11、Core i5、8 GiB RAM；Codex app-server 与 Antigravity ACP 使用 CLI OAuth。Codex/Google 流量经用户配置的代理可达；Surface 到 `api.feitu.net.cn`、`connect.feitu.net.cn`、ECS IP、localhost 与 OAuth 回调直连绕过代理。ECS 到 Google 不可达，ECS 不发送 FCM。上述代理可达性由用户确认，本文没有实测。

## 决策

### 进程和数据所有权

| 角色 | 所在设备 | 所有权与限制 |
|---|---|---|
| 纯客户端 | Mac M2 ARM64、Windows ARM64、Pixel/Xiaomi Android 17 | 不构造本地 Agent runtime、模型 CLI 或 Host listener。Mac/Windows 可按设备 grant 提供资源服务；Android 终端为可选能力。 |
| Agent Host | Surface Pro 7 Windows 11，8 GiB RAM，x64 需实机确认 | 运行 Agent、Codex、Antigravity 和 Host SQLite。Provider API/Google 请求按进程走用户代理；Host 的 ECS WSS 必须直连。OAuth/Keychain/当前用户凭证留在 Host 用户上下文。 |
| ECS 网关 | 阿里云上海、Ubuntu 24.04、2 vCPU、2 GiB、40 GiB，公网 IP `47.100.169.222` | 账户 API、票据/JWKS、Signal/路由、HTTPS/WSS 入口和有界密文转发。不得运行 Agent、模型 CLI、FCM sender 或持久聊天队列。标称最高 200 Mbps 不代表可用吞吐。 |

Host 与各客户端主动连接 ECS。网关可以看到账户/Host/device 路由标识、包长度、时间和连接状态；聊天、文件、命令与终端输出须由端到端帧保护。Host SQLite 是聊天、turn 和任务的权威数据源；gateway 的在线 buffer 不是数据存储。

ECS 首版优先以轻量服务和 SQLite 适配账户 API；不预设 PostgreSQL、Redis、MinIO。只有盘点实际对象需求后才启用 OSS。连接数、队列、日志、帧/分块大小和磁盘均需硬上限；上线容量由 2 GiB staging 压测确定，不承诺固定用户数或带宽。

### 服务和兼容性

- 继续使用现有账户 API 外部语义、已发布 Team API 行为、成员角色、host ticket、`authEpoch` 和撤销规则；只替换 Cloudflare 绑定层。Plan 002 的账户 API 工作与此改造需先对齐，不隐式改变其状态。
- ECS 是受信账户控制面，账户签名根仍在 ECS；不新增外部署名根。账户根可以签发账户授权并影响撤销/路由，系统不声称能抵抗 ECS-root compromise。端点独立持有的 Host/device 身份私钥及 Host 本地 grant 限制 relay 伪装和业务解密/操作授权；这不消除受信账户根被攻陷的风险。
- D1 的 batch、事务、唯一约束、并发和分页语义先列兼容矩阵再适配。账户撤销、成员变更用服务端 durable outbox，ECS 重启后继续投递。该 outbox 只装控制面事件，不装聊天消息。
- 保留 Host SQLite 的权威数据和已发布 schema。事件恢复优先用已有权威查询/快照；旁路 journal 暂作加速索引，不得作为聊天内容权威副本。两个 SQLite 文件不能原子提交；任何声称 durable event ACK 的旁路双写都必须先解决崩溃窗口，必要时才进入主库迁移与数据保全 gate。
- 在 Caddy 或同类入口用 443 提供 HTTPS 与 WSS upgrade。`api.feitu.net.cn` 和 `connect.feitu.net.cn` 是获准的子域名；核对现有 DNS 和网站路由后另行安排修改，不在本 ADR 或阶段 0 改 DNS。TURN 如保留，作为 coturn 的独立 UDP/TCP/TLS listener（如 3478/5349），不能经普通 HTTP reverse proxy。
- 自托管账号登录继续用邮箱验证码；当前企业 SMTP 已有，hostname、port、TLS 与发件地址待补。Cloudflare 不作为运行依赖。

### 设备授权和终端

- 使用独立、版本化的设备文件、设备终端、本地 API capability。Host 和设备创建新的持久 libp2p peer identity；不强行转换或从现有 Ed25519 seed 派生 Noise key。账户 owner 在 Host 本地完成一次配对，并通过 OOB 核对 Host 与设备 fingerprint；双方 pin 对端身份，Host 本地 grant 绑定 device identity、user、capability ceiling 与 epoch。票据/网关响应不能创建或扩大 grant。之后 grant 可持续使用并可撤销，不逐文件或逐命令重问。
- Mac/Windows 文件能力覆盖当前 OS 登录用户可以访问的文件，按其 OS 权限读写/管理。Windows 受 ACL 限制；macOS 受 TCC 保护的路径需要用户通过 OS 的 Full Disk Access。不能自动 UAC/sudo 提权或绕过系统拒绝。
- 设备终端在接收端以当前登录 OS 用户执行任意命令。独立本地 HTTP API 工具可用目的地址 allowlist；此 allowlist 不限制已授权终端的文件、进程或网络能力。
- 终端命令由 `operationId` 标识，进程由 `terminalSessionId` 标识。网络恢复只附着仍存活且身份可验证的原 shell；不能恢复时报告结束或未知，禁止重跑命令。先提议每 session 1 MiB 输出、最多 4 session、断线后 30 分钟清理；阶段 4 实测校准。
- Android 文件能力使用 SAF/App 权限，不因自用变成 root/全盘。Android shell 可选且限于 App sandbox，不是首版交付条件。

### 平台、Provider 与通知

- 自有纯客户端产品使用独立 app/bundle/package ID、服务默认地址、更新源、签名身份和发布通道。目标包为 Mac ARM64、Windows ARM64 接收端、Android 17；保留 Windows x64 Agent Host 构建。检查 Mach-O/PE/ABI/native 依赖/PTY，不能用 x64 翻译代替 ARM64。
- Surface 仅 8 GiB：常驻并发先以 1–2 个 Provider turn 为压测起点，不作容量承诺；优先保留 critical session。Windows 登录用户启动策略要保持 OAuth 当前用户上下文。Host 休眠/关机后 Agent 不会继续工作；不改用户电源设置。
- Android 复用现有 FCM token 轮换和 sealed notification。Firebase 项目在新 Android package ID 确定后建立；`google-services.json` 是公开客户端配置。FCM service-account 私钥仅进入可信 Surface sender；ECS 不访问 Google、不持 sender 私钥。通知仅作无正文唤醒提示，内容从 Host 游标补拉；强停/省电/不可达网络不保证及时。

## 并行工作与实现门

1. **可以立即开始**：Codex app-server 与 Antigravity ACP 的 Host 生命周期原型，只增加显式 opt-in idle residency；不改现有 crash/init retry 次数/间隔，不实现网络长重试或重放。只验证 Host 侧生命周期、8 GiB RSS/临时目录和 Windows 当前用户 OAuth 上下文。WSS 密码学审查不是该原型依赖。
2. **可并行的本地设计/脚手架**：Cloudflare adapter 盘点、SQLite adapter 原型、产品 ID/原生架构矩阵、设备终端 ABI 可行性研究；账户兼容或共同协议文件串行协调。另可进行只用生成测试身份、无业务数据/生产凭证的 Noise 库隔离 feasibility spike；这只提供选型证据，不批准产品身份、握手或 WSS 数据实现。
3. **阻塞项**：任何产品 WSS E2E 帧、握手、密钥/身份轮换代码，必须等 [`011-wss-protocol.md`](011-wss-protocol.md) 的独立 Luna/max 安全审查明确通过。当前两个文档和隔离 spike 都不是该审查结果。
4. 阶段 0 设计门不阻塞上述本地原型或本地服务骨架。真实 DNS、SSH、Firebase/SMTP service account、签名密钥均不在本文索取，也不在本阶段注入。

## 仍未决

- `@chainsafe/libp2p-noise` 的 Noise XX feasibility spike 是否能满足各目标 runtime；OOB pairing 交互、双向 fingerprint pin、peer identity 与 Noise static-key binding、rotation/revoke 流程仍需独立审查。新 peer identity 不迁移现有 Ed25519 seed。
- 旁路 event journal 是否只作 hint，或需要在 `openbot.db` 内增加事务性 outbox；不可在未分析原子性前承诺完整事件 replay。
- Surface 代理配置对 Codex/Antigravity/Google 的逐 CLI 支持与 direct bypass；Surface 实际 CPU architecture/CLI 版本。
- ECS 计费/DNS 当前记录、Windows ARM 接收设备型号/OS、Xiaomi 型号、SMTP 非密钥参数、Firebase 项目尚待阶段化处理。
