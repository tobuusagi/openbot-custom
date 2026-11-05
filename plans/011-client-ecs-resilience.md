# Plan 011: 自有 ECS 上的纯客户端与常驻 Agent 通道（设计稿）

> **状态**：IN PROGRESS。阶段 0、1A、1B、1C 正在推进有限设计/原型；完整纯客户端、Provider 故障恢复、ECS 部署、生产数据迁移和发布均未完成。
> **规划基线**：`bb69c3df4569795c4ed101faecfd9183a830e207`（2026-11-04，工作区干净）。
> **优先级/规模**：P1 / XL。涉及桌面、Android、账户服务、Remote Signal、Provider runtime 和数据恢复。

**Progress update (2026-11-05):** Phase 2 is in progress. Phase 1A idle-session baseline wiring passed local fake-CLI checks. Extended typed initialize-timeout retry work is in progress for opted-in Codex and Antigravity only; network retry remains TODO, Windows OAuth is untested, and default desktop launch, crash retries and turn replay remain unchanged. The interim retry policy gives a visible warning at 24 hours, then lowers the retry rate, with a cap of 48 launches per process-local retry episode. This does not meet Phase 5 continuous-run acceptance. Android client configuration checks passed 12/12 with independent review, but full Phase 1C client work is incomplete. Account service work remains in progress. The old WSS package result (36/36) is stale after source relocation; a fresh reproduction is pending. No production gate is approved.

## 请求与目标

用户希望 Mac、Windows、Android 作为纯客户端连接其自有服务：

1. 纯客户端不启动本地 Agent、模型 CLI 或 Team server。Agent 在用户的 Surface Pro 7 Host 上运行；桌面客户端可按用户本人一次明确授权，提供该 Windows/macOS 登录用户权限内的全文件访问与远程终端。
2. 持久设备授权按 Host 与已配对设备绑定、可随时撤销；授权后不逐文件或逐命令重复弹窗。操作仍服从当前 OS 用户权限，不自动获得 UAC、sudo 或 TCC 权限。
3. 网络中断、切网、网关或执行主机重启后，连接和消息状态可以快速恢复；已确认写入的数据不因断线重发而重复生效。
4. 自有阿里云 ECS 承担账户和公网连接基础设施。常见公网只允许出站 TCP 443 时，客户端仍可连接。
5. 执行主机上的 Provider 会话尽量常驻；Provider 网络错误有长重试窗口，恢复不丢失会话和待处理状态。

## 已确认的部署输入

| 项目 | 用户已确认 | 仍需核对 |
|---|---|---|
| ECS | 阿里云上海；Ubuntu 24.04；2 vCPU、2 GiB RAM、40 GiB 磁盘；公网 IP `47.100.169.222`。ECS 仅运行网关/账户服务，不运行 Agent/Provider；标称最高 200 Mbps，不保证跑满。用户认为可能不按流量计费，但计费方式未确认。 | 实际公网带宽、计费项与费用上限。 |
| 域名/路由 | `feitu.net.cn` 已备案且已有网站；用户允许用 `api.feitu.net.cn`、`connect.feitu.net.cn`。Surface 访问 Codex 与 Google 走用户配置的代理；ECS 对外直连。 | 当前 DNS 记录；Host 代理对各 CLI 的配置细节。不得覆盖现有网站或更改用户系统全局代理。 |
| Agent Host | Surface Pro 7，Core i5、8 GiB RAM、Windows 11；Codex 与 Antigravity 使用 CLI OAuth。i5 通常是 x64，需实机核对进程/系统架构。Surface 代理后访问 Codex/Google 已由用户确认可达，未经本轮实测。 | CLI/Provider 版本；Surface 实际架构、代理隔离和休眠/唤醒设置。 |
| 接收端 | Mac M2 ARM64；Windows ARM 设备，要求原生 ARM64；另保留 Windows x64 Agent Host 构建。Android Pixel 与 Xiaomi，Android 17。 | Windows ARM 设备芯片/OS 与 Xiaomi 型号；Mac OS、可用实机及主要网络环境。 |
| Provider/设备权限 | 首批 Codex app-server、Antigravity ACP；桌面全文件访问与 Windows PowerShell/Mac 终端按持久授权启用。Android 终端可选，不作为必需功能。个人自用。 | 本机 API 的具体地址/用途和用户权限范围。 |
| 邮件/推送 | 已有 `feitu.net.cn` 企业邮箱；希望 FCM 用于 Pixel 通知；Firebase 项目和 Android App 尚未创建。 | SMTP 非密钥参数；待 package ID 定稿后创建 Firebase 项目并注册 Android App。 |

2 GiB ECS 不足以据规格推定连接数、文件吞吐量或峰值带宽；这些都要在 staging 压测后设硬上限。网关不为 Codex、Antigravity 或其他 Provider 代理模型 API。用户已确认 ECS 到 Google 不可达；不在 ECS 部署或测试 FCM sender。

## 推荐默认决策

- **拓扑**：阿里云 ECS 仅承载轻量网关/账户服务；Agent Host 留在用户已有电脑或服务器上，不与 2 核 2 GiB 网关同机。Agent Host 与网关使用独立身份。
- **连接方向**：Mac、Windows、Android 和 Agent Host 均主动通过 TLS/WSS 连接公网入口；首版主路径为 HTTPS/WSS 443。客户端和 Agent Host 不需要公网入站端口。
- **传输**：新增经原型验证的 WSS 消息中继，服务于常规 HTTPS 443 环境；保留现有 WebRTC 直连。TURN 仅作为可选 WebRTC 路径单独配置 3478/5349 等协议端口，普通 HTTP 反向代理不能代理 TURN 协议。首版不把视频流改经 WSS。
- **职责**：账户服务持有账户、会话、成员、邀请和授权元数据；网关转发实时流量，不成为聊天、文件或命令的权威存储。Agent Host 的 SQLite 仍是对话与任务权威数据源。
- **恢复**：实时消息采用带请求 ID、序号、回执和游标的协议；主机侧增量日志只用于短期重放，缺口或过期游标触发从 SQLite 重新读取快照。默认提议保留 7 天或 1 GiB（先达到者优先），此值必须用目标用户规模和磁盘预算校准。超过窗口时不删聊天记录，返回明确的快照补齐结果。
- **客户端待发消息**：复用现有 `clientMessageId` 与回执流程；客户端在收到“已写入 Agent Host SQLite”的持久化回执前保留待发项。客户端数据被卸载、清除或设备损坏不在服务器恢复保证内。协议提供至少一次投递与幂等效果，不宣称 exactly-once。
- **重试**：WSS 连接使用指数退避和 jitter，建议 0.5 秒起步、上限 30 秒；网络不可达时持续重试，24 小时仅升级可见告警/状态，随后仍以可配置的低频间隔恢复，不清空本地待发项。账户撤销、凭证无效或明确永久错误才暂停相应重试。Provider 网络错误单独处理，不能复用账户鉴权失败策略。
- **设备权限**：Mac/Windows 以已配对 Host+设备的一次明确、持久、可撤销授权开放当前 OS 用户权限内的全部文件和远程终端；不逐文件/逐命令重问。Android 仍遵循 SAF/系统权限，不 root、不承诺全盘。
- **FCM**：复用 Android token 注册、token 轮换和 sealed notification；Google sender 移出不可达 Google 的 ECS，默认由 Surface Agent Host 经其代理出站发送。FCM 只发无敏感正文的 sealed 提醒/唤醒，客户端恢复后从 Host 游标补拉。
- **产品构建**：新增独立纯客户端产品标识、应用包名/签名身份、默认服务地址、更新源和发布通道。官方产品的自动更新不能覆盖自有 ECS 默认配置，也不能把宿主功能重新装入该产品。Windows ARM64 接收端必须运行原生 ARM64 包；保留 Windows x64 Host 包。
- **路由**：Surface 的 Codex/Google 出站由用户代理；Host 到 `api.feitu.net.cn`、`connect.feitu.net.cn`、ECS IP、`localhost` 及 OAuth 回调直连绕过代理。按 Provider/FCM 发送进程分别核对代理变量和目的地 bypass，不设置系统全局代理、不记录代理凭证。

以上数字和拓扑是供实现的提案，尚未经过部署或实测。第一阶段可以根据用户资源信息调整；不可把提案写成已经达到的服务等级。

## 当前实现与边界证据

以下依据仓库源码、计划文件和文档抽查，基线为上方 commit。查找范围有限的事实会在实施阶段再次验证。

| 区域 | 已确认事实 | 对本计划的影响 |
|---|---|---|
| 桌面启动 | `src/main/index.ts:1242` 统一调用 `createApplicationServices`；`:1585` 启动 `agentInitialization`。真实桌面应用是本地 Agent/Host 与客户端的混合产品；`developmentTestClient` 是开发用途。 | 纯客户端必须有独立运行模式和打包配置，确保它不构造或启动本地 Agent、Provider、Host listener。不能只隐藏菜单或改默认 URL。 |
| 移动端/FCM | `apps/mobile/src/features/push-notifications/android-push-notifications.android.ts` 已取 FCM token、监听轮换并请求通知权限；`app.config.js` 可选加载公开的 `google-services.json`。Host `src/main/push-notifications.ts` 封装 sealed 通知；当前 `apps/auth-api/src/server/android-notification-relay.ts` 使用 `FCM_SERVICE_ACCOUNT` 请求 Google OAuth/FCM。 | 保留手机端注册和 sealed 解密路径；将可信 FCM sender 迁到 Surface Host 代理出站。ECS 到 Google 不可达，不能部署 FCM sender。FCM 受 Google 网络、权限、省电、强停影响，不承诺任意条件及时送达。 |
| 移动端权限 | `apps/mobile/app.json:5` 配置 iOS 和 Android，Android 屏蔽广泛媒体读取权限；`apps/mobile/README.md` 有 Android 构建路径。 | Android 文件/终端能力仍由 SAF、App sandbox 和系统权限决定；Pixel 小米均为 Android 17 的实机验收范围。 |
| 终端/PTY | `src/backend/provider-terminal-login.ts` 仅为 Provider CLI 登录打开系统 Terminal/PowerShell；未发现通用远程终端或 `node-pty`/ConPTY 适配。 | 新增设备终端 capability；Windows ARM64 ConPTY/本机依赖要单独验证。Agent CLI 登录辅助功能不能冒充通用终端。 |
| 原生架构 | `package.json` 的 `package:win`/`dist:win` 和 `electron-builder.yml` 的 Windows target 明确为 x64；未见 Windows ARM64 打包脚本。Android 包 ID 当前为 `run.openbot.mobile`，不是用户的新 Firebase App ID。 | 新建纯客户端 package identity，并补 Windows ARM64 原生构建；不能用 x64 翻译声称 ARM64。保留 x64 Host 构建。 |
| 客户端恢复 | `packages/team-client/src/remote-recovery.ts:24` 目前是 2/4/8/16 秒、最多 5 次后 30 秒 cooldown，并有 20% jitter；cooldown 后会继续下一轮，不是达到五次就永久停止。文档中的旧间隔描述已过期。 | 已有循环恢复基础。目标是检测断线更快、重试状态更清楚，并补足 Host 重启后的持久事件恢复；按网络实际测量重连时延。 |
| WebRTC 恢复 | `packages/team-client/src/remote-peer.ts:386-390` 有 disconnected 宽限、ICE restart 和 Signal 更新；`:1505` 起处理事件序号、重复、缺口和 ACK。 | 可复用其序号、重放和回执语义，但 WSS 建立独立传输适配；不得改变已发布 Team API 的含义。 |
| 账户与 Remote | `remote/README.md:10-16` 描述 Cloudflare API/D1 检查成员并签 ES256 ticket，Signal 只转 SDP/ICE，rpc/events/files 通过 WebRTC/coturn。 | ECS 账户签发方、ticket key 和 Signal 必须同属自有信任域；WSS 是新数据传输，不能只替换 Signal URL。 |
| 自托管现状 | `docs/self-hosting.md:25-29` 仍要求 Cloudflare Workers、D1、R2；官方账户 Worker 不会为另一 Signal 签票。`remote/compose.yaml` 仍以 Cloudflare DNS token 自动签证书。 | 当前部署不是完整自托管。迁移包括账户 API、数据库、对象存储、定时任务、限流、邮件、证书和 DNS；ECS 域名与证书必须脱离 Cloudflare 依赖。 |
| ECS 文档 | `docs/aws-ecs.md` 介绍的是 Amazon ECS/EC2。 | 不将它当作阿里云部署指南；新增阿里云 ECS 的独立运行说明和故障恢复说明。 |
| 账户服务适配 | `apps/auth-api/src/server/types.ts` 有 D1、R2 和 RateLimit 绑定；代码还用到 `cloudflare:workers`、`cloudflare:sockets`。`worker-handler.ts` 有 scheduled 清理、待发撤销事件、托管站点等任务。未见核心 Durable Object 绑定。 | 使用 Bun/Node 服务适配并逐一替换 Cloudflare 绑定语义；验证 D1 batch/事务行为。不要假设或虚构 Durable Object 迁移。单机规模先评估 SQLite，不预设 Redis/Postgres。 |
| Agent Host 数据 | 仓库约束规定用户 SQLite 是权威数据源；现有 Remote 网关不存聊天、文件或命令。 | 保持 OpenBot SQLite 为对话、任务与文件权威来源。避免第一步改 `openbot.db` schema；优先评估旁路增量日志，确需迁移时另设数据保全 Gate。 |
| Provider 生命周期 | `src/backend/agent/provider-runtime.ts:136` 有约 8 小时 20 分的整体 idle 策略；Claude/ACP 各有约 10 分钟、最多两个 idle session 的策略；低内存时有回收保护。进程退出与初始化已有有限重试，启动超时也有重试。`src/backend/provider-drivers.ts:966-1019` 是 Antigravity ACP driver；`:247` 涉及 macOS Keychain 登录/主机账户目录，`:278` 涉及 Windows 每次启动约 310 MB 解包。 | 首批只对 Codex app-server 和 Antigravity ACP 做深入恢复验证；核对 CLI 内部 retry。网络 retry 不等同无条件重启进程；防止重复解包和临时文件增长。登录态和 OS 凭证留在 Agent Host，ECS 不代转模型 API。 |
| 客户端到设备资源 | 未发现通用 server-to-client 文件或本地 API 桥。当前 Agent Host 的本地路径不能代表远端客户端路径。 | 新增独立设备资源 capability 与工具；显式设备身份、权限授予/撤销、审计和边界检查。 |
| 密码学与 WSS | WebRTC 数据通道具备其传输层安全，但这不能自动移植为 WSS 的端到端加密。 | WSS 负载端到端加密设计必须先过协议审查，复用成熟密码库和已有身份绑定；不可自行发明密码学，也不能把 TLS 当作端到端加密。 |
| 发布身份 | 当前目标是新增独立纯客户端产品构建；Linux 工作环境不能证明 macOS、Windows 或 Android 真实包可用。 | 产品 ID、更新 manifest、签名、公证、Android keystore 与真实设备验证是单独发布 Gate。 |

## 产品目标与非目标

### 目标

- Mac、Windows、Android 安装的自有服务客户端负责登录、展示、消息输入、同步、通知，以及按一次持久设备 grant 访问桌面 OS 用户权限内的文件/终端。
- 自有 ECS 只运行轻量账户服务、Signal/路由、WSS 中继和运维监控，不依赖 Cloudflare 账户、Worker、D1、R2、RateLimit、DNS API 或 Cloudflare socket。
- Agent Host 在用户已有电脑/服务器运行 Agent 和 Provider，主动连入 ECS，并以自己的 SQLite 数据库提供恢复后的权威状态；Provider API 由 Host 直接访问。
- 网络失败时提供明确的连接、发送、接受、完成和失败回执；同一消息重试不会重复启动已接受的任务。

### 非目标

- 不在纯客户端启动内置 Agent runtime、模型 CLI、Team server 或可公网访问的监听端口；终端工具只运行用户主动授权的当前 OS 用户命令，不自动提权。Agent/Provider 仍只在 Agent Host 运行。
- 不把聊天、附件、命令或 Provider 数据库迁入账户服务或网关；不把 WSS 用作首版视频中继。
- 设备文件/终端工具按设备 grant 隔离，不把远端路径伪装为 Host 路径。独立本地 API 工具使用用户 allowlist；此 allowlist 不限制已授权终端可执行的任意用户命令及其 OS 权限。
- 不承诺任意长度离线后仍保有全部事件，不承诺数学意义上的 exactly-once，也不在恢复时盲目重放可能已产生副作用的 Provider turn。
- 不承诺 Android 被系统挂起或强制停止时仍能秒级维持 socket。后台通知需单独适配 FCM/厂商推送/前台服务策略并遵循 Android 系统政策。
- 不改变 PolyForm Noncommercial 1.0.0 许可证，不增加不兼容依赖，不自动提交、开 PR、迁移生产数据、部署或发布。

## 建议架构

```text
Mac / Windows / Android 纯客户端
  ├─ HTTPS + WSS :443 ─────── 阿里云上海 ECS（轻量账户服务 / Signal / 有界 WSS router）
  │                              ↕ Agent Host 也主动 WSS；ECS 不保存聊天和离线消息
  ├─ 可选 WebRTC ──────────── 用户已有 Agent Host（可单独配置 coturn）
  └─ 用户授权的本机文件/API ← 受限 device-resource capability → 用户已有 Agent Host
                                  └─ Agent / Codex / Antigravity / SQLite
```

ECS 只运行轻量网关/账户服务；Agent Host 是 Surface Pro 7 Windows 11，不部署到网关 ECS。Host 主动建立可恢复的认证 WSS 连接，避免要求家庭网络或 Android 设备开放入站端口。

### 账户、票据和 ECS 服务

- 将现有账户 API 对外行为和 D1 数据语义列为兼容基线：登录、会话、成员、邀请、角色、host ticket、`authEpoch`、撤销、邮箱验证、限流、数据清理和必要的头像/静态对象。
- 账户 API 签发短期、受 audience 限制的 ticket；Signal/WSS router 只校验自有 JWKS，并将身份、host、设备、角色、协议版本和撤销代际绑定。私钥不得放入客户端或 Agent Host 日志。
- 2 核 2 GiB/40 GiB ECS 先评估轻量单进程服务和单机 SQLite；不预设 PostgreSQL、Redis、MinIO 全套服务。只有确认头像/对象体量和备份需求后才考虑阿里云 OSS。聊天内容始终留在用户 Agent Host 的 SQLite；账户数据库、可选 OSS 对象和备份分别定义上限与恢复流程。
- 将 D1 batch、外键、并发写入、唯一约束和事务边界建立兼容测试清单，再实现 Node/Bun adapter。限制器、邮件、cron、证书续期分别使用独立适配器。
- 账户撤销、成员变更使用 durable outbox，Signal 无法接收时在服务进程恢复后续投递。过期会话清理、邮件重试、outbox 清理和备份检查不依赖 Worker `scheduled` 或 `waitUntil`。
- 由 Caddy 或等价反向代理在 443 终止 TLS 并正确转发 WebSocket upgrade、连接时长、背压和关闭状态。可评估 `api.feitu.net.cn` 和 `connect.feitu.net.cn`；先查现有 DNS 与站点再形成改动方案，当前不改 DNS、不覆盖现有站点。证书使用 HTTP-01 或阿里云 DNS API；部署不依赖 Cloudflare。
- 网关只保存账户/路由控制元数据和有界的在线密文缓冲，不提供持久离线聊天队列。限制连接总数、单连接 buffer、帧大小、路由队列、日志和磁盘使用；限额在 staging 测量后固化。文件只流式分块转发并施加背压，禁止整文件缓存在网关内存或磁盘。带宽未知，连接数/吞吐必须实测后设置硬上限。
- TLS/WSS 443 是首版主数据路径。可选 TURN 需要独立 UDP/TCP/TLS 监听和防火墙配置；普通 HTTP 反向代理不能转发 TURN 协议。WSS 可用时无需启用 TURN。
- 日志只记录 request ID、服务状态和脱敏后的路由元数据。不得写入 ticket、token、文件内容、聊天正文、Provider secret 或设备 API 返回值。

### WSS、WebRTC 与事件状态

- WSS 提供 auth/bootstrap、心跳、设备与 Host 会话、实时路由、ACK、恢复游标和文件分块控制；消息遵守现有 Team API 语义，新增能力使用版本化 capability。
- 网关仅按已认证的 account/host/device/route 转发密文和必要的路由元数据。建立端到端设计：设备身份与密钥绑定、密钥轮换和撤销、会话密钥协商、nonce/重放防护、协议降级策略、最大帧、分块完整性及错误关闭行为。实现前由独立安全审查 Gate 审核，并优先复用成熟实现。
- WebRTC 直连/coturn 可用时继续承载当前传输；WSS 作为企业代理、受限网络或 ICE 失败时的数据通道。选择和切换期间有 generation/epoch，旧连接迟到的帧不得覆盖新连接状态。
- 每个客户端请求有稳定 request ID；客户端消息保留 `clientMessageId`。Host 收到请求后，先在权威路径中持久化并形成 receipt，再确认“已接受”。对相同 ID 的重放返回原 receipt；不得因网络 ACK 丢失重复创建任务。
- 实时事件有 host-scoped 单调游标，并在同一游标域确认和续传。断线后先按游标补拉；检测到游标过期、缺口超限或 host epoch 改变时，返回 snapshot-required，并从 host SQLite 拉取权威快照后建立新游标。
- 提案日志仅在 Agent Host 保存，7 天或 1 GiB 达到上限即压缩/清理旧增量。网关不持久化聊天或离线消息；它只持控制元数据和有界的在线密文转发缓冲。纯客户端本地 outbox 保存到 Host 写入回执、用户取消或用户清除应用数据。界面区分“本机待发送”和“Host 已接收”。
- 日志/回放不得重演 Provider 已执行的工具副作用。Host 重启或断线时通过 durable turn/task ID、Provider session ID、事件 receipt 和执行状态做 reconciliation；对状态不明确的 turn 标记需恢复/人工决策，不自动再跑一遍。
- 文件传输做流式分块、顺序/偏移、总长度限制、超时、背压和最终 hash 校验。提案上限：单 chunk 不超过 256 KiB、每连接待处理数据不超过 1 MiB、网关全局在线转发缓冲不超过 128 MiB；超过时施加背压或拒绝新传输，不把整文件放进网关内存/磁盘。阶段 0–1B 要在 2 GiB ECS 上测量并据实调整；连接总数设成经压测支持的硬上限，带宽未知前不承诺吞吐。断线续传要校验授权代际；未经授权的旧分块不能恢复写入。

### 客户端设备资源授权

- 新增独立 `client-device-files-v1`、`client-device-terminal-v1` 和 `client-device-local-api-v1` capability，不改已发布 Team API 含义。设备文件/终端工具与 Agent Host 文件/终端工具分开命名，绝不把远端路径显示成 Host 本地路径。
- 配对后由用户本人对具体 Host+接收设备作一次明确的持久授权；grant 可撤销、和设备密钥绑定。授权后不逐文件或逐命令重复确认，不把权限给同一账户的所有设备，也不因恢复连接而延长已撤销 grant。
- Mac/Windows 桌面文件工具覆盖当前登录 OS 用户可以访问的全部文件，默认按该用户现有权限读写/管理；不额外限制为选定目录或只读。Windows 仍受 ACL 限制；macOS 受 TCC 保护的目录需用户在 OS 设置中授予 Full Disk Access。任何平台均不绕过 ACL/TCC，不自动 UAC/sudo 提权。
- 终端工具允许在接收端以当前 OS 用户执行任意命令；API allowlist 只约束独立的本地 API 工具，不能限制终端命令的文件、进程或网络能力。协议需支持 open/execute/input/output/resize/cancel/exit，包含稳定 `terminalSessionId`、每命令 `operationId` 和输出游标。断线后仅当原 shell 仍存活且 session 身份可验证时才附着；客户端/OS 重启后无法恢复原进程时明确返回结束或状态未知，绝不重放命令。
- 终端默认 cwd 在当前用户目录，命令继承该用户的正常进程环境；用户或 Agent 可在授权会话中指定 cwd/env。输出缓冲建议上限 1 MiB/会话、最多 4 个会话；连接中断后可恢复 30 分钟（均为提案），到期清理进程树和缓冲，退出时回收孤儿会话。日志不记录完整命令、环境变量或 stdout/stderr。
- 本仓库当前只发现 Provider CLI 登录辅助；它不能充当远程终端。Windows ARM64 必须验证原生 PowerShell/ConPTY 与全部 native 依赖；Mac M2 使用本机 shell/PTY。若所需 native binary 不支持目标架构，该阶段保持阻塞，不能退回 x64 翻译并声称支持。
- Android 文件访问使用 SAF/系统 grant；不因个人自用自动 root、开放整盘或访问其他 App 私有目录。Android 终端是可选项，只能使用 App sandbox/已获系统能力；Termux bridge 或广泛系统 shell 需另行验证，不是首版门槛。
- 本地 API 工具仅允许用户配置的具体 listener、端口、HTTP method、path、请求/响应上限和超时；防 DNS rebinding、重定向越权、凭证透传及 loopback 管理接口访问。此 allowlist 不约束上面已授权的通用终端。
- 每个请求绑定 grant ID、账户/Agent/Host/设备身份和 `operationId`。持久审计记录工具类型、目标设备、状态与时间，不记录文件/API 正文、认证头、代理口令或终端输出。撤销时拒绝新请求并取消可取消的活动操作。

### Android FCM 推送

- 复用现有 Android token 获取/轮换监听、通知权限、sealed notification 和服务器撤销流程。新纯客户端 Android package ID 定稿后，用户再创建 Firebase 项目并注册 Android App；`google-services.json` 只含公开客户端配置，FCM service-account 私钥仅在可信发送端配置。
- 当前 FCM sender 在 `apps/auth-api`，而用户确认 ECS 无 Google 出口。迁移目标是 Surface Agent Host 通过其专用代理连接 Google OAuth/FCM；ECS 仅管理账户/token/授权并按需转发不含敏感正文的 opaque 触发信息，不调用 Google、不保存 FCM 私钥。若 Surface 后续不再有可用代理，需用户另选可达 sender；不自动增加境外云或 Cloudflare。
- 代理只应用于 Codex、Google/Antigravity CLI 和 Host 上的 FCM sender。Host 到 ECS HTTPS/WSS、ECS IP、localhost/OAuth callback 直连绕过代理。验证逐 CLI 的代理支持、域名目的地和 bypass；不改 Windows 全局代理或输出代理凭证。
- FCM 只发密封、无敏感正文的提醒/唤醒；恢复后从 Host 游标读取权威事件。Android 17 Pixel 验证通知授权、Google Play services、token 轮换/撤销和前台网络可达；Xiaomi 做后台限制实测，厂商推送可后续考虑。不可承诺设备强制停止、Google 网络不可达或省电限制下及时送达。

### Provider 常驻与重试

- 增加 server-role `alwaysOn` 生命周期策略，从 Host 角色传入 runtime、pool、Provider adapter 和 shutdown 流程；纯客户端不创建这些服务。
- 首批只对 Codex app-server 与 Antigravity ACP 核对 session restore、resume token/session ID、进程内 idle 机制、CLI 自身 retry 和 SDK 回退行为；其他 Provider 不扩展首批实测范围。不要用一处 idle 常量代替验证。
- 重点验证 Codex app-server 与 Antigravity ACP 的内外层 retry、session ID 恢复、登录态和进程生命周期；其他 Provider 只做兼容性回归，不扩大首批深度验证范围。Antigravity 在 Windows 的重复启动解包和临时目录增长要纳入资源观测；macOS Keychain/Host 用户目录登录态留在运行 Host 的电脑。
- Surface 仅 8 GiB RAM，初始并发提案为 1–2 个 Provider turn，待 RSS/解包/临时文件压测后调整；对标记为 critical 的活动 session 保持可恢复状态，继续遵守内存压力保护。Codex/Antigravity OAuth 必须运行在 Surface 当前登录用户上下文。
- 对 Codex、Google/Antigravity CLI 与 FCM 分别配置代理出口；Host 到 `api.feitu.net.cn`、`connect.feitu.net.cn`、ECS IP、localhost 和 OAuth 回调绕过代理。逐 CLI 核对代理支持和实际请求目的地；不更改 Windows 系统全局代理，不记录代理凭据。用户确认代理后可达，本轮未实测。
- 对 DNS/TCP/TLS 断开、429、5xx、Provider 进程 crash、配置错误、401/权限撤销和额度耗尽分类。瞬态错误采用有上限的指数退避和 jitter；建议 24 小时后升级为可见告警，但继续以可配置低频率尝试恢复且保留 session/turn 状态。只有明确的认证撤销、凭证错误或永久配置失败才暂停并提示用户。网络 retry 不触发无条件 Provider 重启。
- 断线不意味着取消 Provider 正在运行的请求。恢复时先查询/恢复原 session 和 turn 状态；只有确认 Provider 没接受该 turn 时才能重新提交。结果不确定时停止自动重放，避免重复工具写入、副作用或收费。
- idle session 不因网络中断而立即销毁。always-on 主机优先保留活动与可恢复会话；仍受内存预算、Provider 限额和现有低内存保护约束。内存压力下记录可恢复标识并优雅回收，恢复后重新连接 Provider，而不承诺所有 Provider 进程无限期驻留内存。
- Agent Host 按 OS 选择受控后台启动方式：Windows 使用当前登录用户上下文的计划任务/登录启动策略，Mac 使用 launchd 或用户会话；Ubuntu ECS 网关单独由 systemd 管理。每端支持进程退出清理、健康状态、磁盘/RSS/SQLite 监控和备份告警。
- CLI 常驻不代表 Surface 休眠或关机时继续工作。阶段 5 验收要求 Host 供电、唤醒和网络可用，并将 Windows 登录用户后台启动与电源策略列为独立运维步骤；当前不修改用户电源设置。

## 分阶段实施计划

阶段 0 完成设计、兼容和风险清单后，独立轨道可并行开展。任何触及共同协议、账户 schema、产品配置或 `openbot.db` 的改动必须串行合并和复核。阶段验收通过后，在已授权范围内自动继续；只有缺少必须外部信息、将执行破坏性数据操作或真实生产发布时才暂停。

| 阶段 | 状态 | 依赖与关系 |
|---|---|---|
| 0 范围/协议门 | IN PROGRESS | 角色/数据 ADR 与 WSS 审查草案已写；独立密码学审查尚未通过，WSS E2E 实现仍禁止。 |
| 1A Provider 原型 | IN PROGRESS | 当前只实现 opt-in idle 常驻；不改进程 crash/init retry 上限。长重试/错误分类留后续阶段。 |
| 1B ECS 骨架 | IN PROGRESS | 当前实现 SQLite runtime adapter 原型；不代表完整 Cloudflare 迁移或可部署 ECS 服务。 |
| 1C 纯客户端边界 | IN PROGRESS | 当前做独立 ARM client package 配置与架构 validator；不代表完整可运行纯客户端。 |
| 2 账户服务 | IN PROGRESS | 依赖 0、1B；与 1A/1C 已独立的工作并行。当前本地账号服务尚未完成生产兼容与迁移门。 |
| 3 WSS/补拉 | TODO | 依赖 0 加密门、2；与 Provider 原型独立。 |
| 4 设备授权 | TODO | 依赖 0 threat model、3。 |
| 5 Host 常驻/运维 | TODO | 依赖 1A、2、3；Agent Host 在用户已有电脑/服务器。 |
| 6 集成/迁移准备 | TODO | 依赖 2–5 的 staging 证据。 |
| 7 签名/发布门 | TODO | 依赖 6、目标平台签名资料；签名/公证只在此阶段需要。 |

### 阶段 0：范围核对与协议设计门

**输入**：本计划、当前代码基线、计划 002 的未完工作、用户回答的资源/兼容要求（见“需用户提供的信息”）。

**工作**：

1. 抽查 `apps/auth-api`、`remote/api`、`packages/team-client`、`packages/contracts`、桌面启动、Android 文件授权和各 Provider runtime；更新上表中会变化的实现事实。
2. 盘点 Cloudflare 账户状态、D1 schema/唯一约束/事件 outbox、R2 对象类型、RateLimit、scheduled jobs、邮件和 DNS/证书行为。标出哪些数据要迁移、哪些只保留备份。
3. 先定义 WSS capability、身份/权限模型、事件游标、消息回执、重放防护、最大帧、文件分块、epoch、背压和 TLS 终止信任边界。
4. 由独立审查者在编码前审查 WSS 端到端加密的威胁模型、成熟密码库选型、身份绑定/撤销和降级策略；未通过不进入 WSS 加密实现。
5. 与计划 002 对齐账户 API 及 Cloudflare 部署的交叠范围，列出序列化修改边界；不自行改变 002 的历史状态。

**当前状态/产物**：角色/数据 ADR 与 WSS 协议审查草案已写；Cloudflare 替换清单、完整兼容矩阵、设备威胁模型和回退流程继续完善。独立密码学审查尚未通过。

**完成标准**：账户行为、信任边界、数据所有者、游标/ACK/快照规则、设备授权范围、回滚方法和外部依赖均可按清单逐项验收；端到端密码学审查有独立书面通过意见。当前该审查未通过；不得实现 WSS E2E 数据或 crypto。缺少签名密钥不阻塞本地原型。

### 阶段 1A：Provider 常驻原型（与 1B/1C 并行）

**输入**：阶段 0 的角色定义、Host 数据/turn ID 盘点；不依赖 ECS 部署完成。

**当前实现范围**：仅对 Codex app-server 与 Antigravity ACP 增加 Host 选择启用的 idle-session 常驻策略；发布默认值保持原样。此切片不调整 Provider 进程 crash retry、initialization retry 次数/间隔，也不实现断网长重试或完整 turn reconciliation。

**工作**：

1. 用 opt-in 标志验证 `alwaysOn` 如何贯穿 Provider runtime/pool 的 idle 生命周期，不改变默认行为。
2. 在 Surface Host 目标环境检查 idle session 的保留、显式关闭和内存压力回收；观察 Codex/Antigravity session ID 与资源占用。
3. 记录当前 crash/init retry 参数作为基线，不修改这些上限；将网络错误分类、延长 retry 窗口、Host 重启后的 reconciliation、重复提交防护列入后续阶段。

**产物**：opt-in idle 策略、Provider 支持记录和受控内存/会话原型数据。crash/init 与网络 retry 状态机仍为 TODO。

**完成标准**：Codex/Antigravity 可通过显式 opt-in 保留 idle session，默认路径不变；现有 crash/init retry 数值保持不变并记录清楚。不得将该切片描述为已经实现 crash/init 分类、网络长重试、断网/重启恢复或命令副作用 reconciliation；这些留待后续阶段。

### 阶段 1B：ECS 服务骨架与 Cloudflare adapter 清单（与 1A/1C 并行）

**输入**：阶段 0 的账户兼容矩阵、阿里云资源/域名约束。

**当前实现范围**：SQLite runtime adapter 原型正在进行。此状态不代表 D1 语义兼容、完整账户 API 迁移、生产数据导入或可部署 ECS 服务已经完成。

**工作**：

1. 建立本地 Bun/Node 服务入口、环境配置 schema、health/readiness、结构化脱敏日志和可重复的服务启停；不写生产凭证。
2. 做 D1 batch、事务、并发和分页行为验证，优先评估轻量 SQLite；只有现存对象数据和用量证明需要时才接入阿里云 OSS，不默认配置外部数据库/缓存/对象存储全套。
3. 拆分 HTTP API、Signal、WebSocket router、持久 outbox、限流、邮件和定时清理的进程所有权与故障边界。
4. 设计 Caddy/反向代理配置、WSS upgrade/timeout、证书续期、最小防火墙、systemd/Docker restart、ECS 磁盘/备份/恢复操作。

**产物**：可在开发机运行的服务骨架、配置变量名表、D1 兼容风险表、ECS 部署草图和运维手册初稿。

**完成标准**：服务能在无生产 secret 的开发模式启动；配置缺项报出变量名但不泄密；health/readiness 区分服务可用和依赖未就绪；同一构建可以在本地 SQLite adapter 下进行窄范围 E2E。仅有架构草案时不称为可部署。

### 阶段 1C：纯客户端产品边界与平台身份（与 1A/1B 并行）

**输入**：阶段 0 的客户端产品决策及目标系统/发布渠道。

**当前实现范围**：独立 ARM client package 配置与架构 validator 正在进行。此配置/validator 不能证明完整纯客户端可登录、保持连接、运行设备能力、完成原生打包或可发布。

**工作**：

1. 设计独立产品 variant/config：app ID、bundle/package ID、图标/名称、服务默认 URL、runtime flags、版本、更新 manifest 与发布通道；Android package ID 必须先于 Firebase 注册定稿。
2. 明确运行时能力矩阵：纯客户端不创建 `agentInitialization`、Provider pool、Host Signal peer 或本地 server mode；启用登录、加入 Host、同步、消息、持久全文件 grant 和设备终端 capability。
3. 固定原生构建矩阵：Mac M2 `arm64` 客户端；Windows 接收端原生 `arm64`；Surface Agent Host 保留 Windows `x64` 包。抽查 Electron、ConPTY/PTY 与 native npm/runtime 依赖的架构，不接受 x64 转译替代 ARM64。
4. Android 目标为 Pixel 与 Xiaomi Android 17；package ID 定稿后由用户创建 Firebase 项目并注册 Android App。`google-services.json` 作为公开客户端配置；服务账号私钥只进入 Surface sender 的安全凭证渠道。
5. 盘点 desktop 的 main-process service composition 和 mobile 远端会话路径，安排最小边界改造；固定独立更新源/签名身份，防官方自动更新覆盖自有服务配置或装回 Host 功能。

**产物**：构建 variant 决策、平台 ID/ABI 矩阵、功能表、更新通道清单、Firebase App ID 和数据目录策略。

**本阶段配置验收标准**：validator 分别识别 Mac ARM64、Windows ARM64 接收端、Windows x64 Host 和 Android package ID，且配置没有把 Host/Agent 功能并入纯客户端。该结果只完成边界配置，不代表完整纯客户端能登录或可发布；完整运行时仍需后续阶段。Firebase 注册资料未备齐不阻塞 package 配置；签名和实机发布检查留到阶段 7。

### 阶段 2：自有账户服务与数据兼容

**依赖**：阶段 0 账户兼容矩阵及阶段 1B 服务骨架。与阶段 1A、1C 已完成部分并行；生产数据切换不在本阶段自动执行。

**工作**：

1. 实现 Node/Bun HTTP adapter 和自有 ticket signing/JWKS；保持已发布客户端 API 语义，新增能力采用版本化协议。
2. 替换 D1、R2、RateLimit、`cloudflare:workers`、`cloudflare:sockets`、scheduled 和 `waitUntil` 边界；实现 SMTP/TLS、限流和清理 adapter。
3. 实现 durable 撤销 outbox、可重试邮件/外部事件和会话过期清理；为所有后台任务定义幂等键、重试、告警和停止规则。
4. 将 Android FCM Google sender 从账户 API 移到 Surface Host；ECS 只管理 token/授权及可选 opaque trigger，不访问 Google。保持 sealed payload、token rotation/revocation 和客户端协议兼容。
5. 加入账单/托管站点等超出客户端目标的模块要先标明产品需要；不得以迁移名义静默开放或删掉现有入口。
6. 为 D1 数据导出/导入定义可校验格式：行数、ID、约束、角色、session epoch、文件对象 hash 和迁移报告；旧数据原样保留至新服务验证与回退期结束。

**产物**：自有账户 API、数据 schema/adapter、迁移命令（仅可在明确环境运行）、报告与回退手册。

**完成标准**：兼容矩阵中每个账户/会话/授权行为有窄 E2E 证据；新旧数据抽样和全量计数一致；ticket 不能被旧/其他服务信任域接受；撤销在服务重启后继续投递。任何生产导入、切 DNS 或删除旧数据须另行明确授权。

### 阶段 3：WSS router、事件补拉与桌面/Android连接

**依赖**：阶段 0 加密协议门、阶段 2 自有身份/ticket。Provider 原型可以继续独立。

**工作**：

1. 实现网关 WSS 控制面与实时中继，验证最大帧、连接背压、代理超时、心跳、关闭码、连接 epoch 和单连接/多连接策略。
2. 实现端到端密文帧，复用已通过审查的库和身份绑定；通过测试确认网关只见必要路由元数据。TLS、ticket 签名和 WebRTC DTLS 不代替此层。
3. Host 持久化游标/事件增量，按 user/host authorization 裁定 resume、ACK、snapshot-required 和授权撤销；对 `openbot.db` 使用只读查询/现有 writer 接口。
4. 先做旁路 SQLite journal 原型，检查双写崩溃、乱序、WAL checkpoint、容量压缩及 snapshot 回填。若无法可靠与 SQLite 权威数据协调，必须先设计独立 migration、所有已发布 schema 备份和数据保全 Gate，再修改主库。
5. 将客户端恢复状态机接入 WSS 与现有 WebRTC peer，按游标或 receipt 切换并防旧连接状态覆盖新连接；保留移动端 outbox 和 host 权威回执。
6. 首次配对/连接流程明确显示服务器地址、证书状态、设备、Host 身份和失败原因；网络恢复后先拉状态，再渲染实时事件。

**产物**：版本化 WSS capability、Host journal/补拉 API、客户端连接与恢复 UI、数据流图和容量观测。

**完成标准**：客户端可在仅开放 TLS TCP 443 的测试网络建立 WSS；WebRTC 禁用时 RPC/events/文件分块可走 WSS；服务端重启后 ACK/游标恢复或明确进入 snapshot 补齐；重复 request 不重复创建 turn；事件日志截断不会截断 SQLite 聊天数据；文件收件 hash 相同。

### 阶段 4：客户端设备文件、终端与本地 API grant

**依赖**：阶段 0 threat model、阶段 3 认证 WSS capability。桌面和 Android 平台 adapter 可按不同 owner 并行编写，但共享 capability/schema 先确定。

**工作**：

1. 实现设备密钥和一次性的用户确认，建立具体 Host+Mac/Windows 接收端的持久全文件/终端 grant；支持撤销、权限变化通知和 in-flight cancellation，不为每个文件或命令再问一次。
2. Windows 文件 adapter 在当前登录用户 token 下工作并遵守 ACL；Mac 在用户授予 OS Full Disk Access 后访问受 TCC 保护路径。不伪造提权、不覆盖 OS 拒绝结果。
3. 审查现有 process/terminal 实现与 native 依赖；实现 Mac M2 shell/PTY 和 Windows ARM64 PowerShell/ConPTY。每条输入输出带 session/operation ID、序号、窗口大小和 exit 状态；断线后附着原进程、查询进度/输出，不重发已提交命令。
4. 实现有界输出（提案 1 MiB/session、最多 4 sessions）、背压、30 分钟 orphan session 保留和退出进程树清理；Windows 孤儿和重复启动不能增长临时文件。实际阈值在设备内存/恢复测试后调整。
5. Android SAF 选择和持久 URI 授权按系统能力实现；文件 access 不因个人自用变成 root/全盘。Android terminal 可选，只评估 App 权限 shell；Termux bridge 不作假设或首版依赖。
6. 独立本地 API 工具用具体服务/端口/method/path allowlist，防任意代理、重定向越权、loopback 管理接口访问和大 body。明确此限制不约束已授权终端命令。
7. 工具区分设备与 Host 文件/终端，绑定账户/Host/设备/grant/operation ID。审计可记操作类别、时间、退出码与游标，不记录命令全文、环境变量、正文或终端输出。

**产物**：版本化设备文件/终端/API capabilities、Mac/Windows/Android adapters、grant 撤销流、审计事件和 Android 权限说明。

**完成标准**：没有具体设备 grant 时 Host 不能访问；撤销后新请求被拒；桌面操作只使用当前 OS 用户权限，授权后不弹逐文件/逐命令确认；Android 只访问 SAF/App sandbox。Win ARM64 与 Mac ARM64 的终端真实架构受测；断线恢复附着同一 terminal session 且绝不重放命令；buffer 和 orphan 清理有界；纯客户端不启动 Agent、模型 Provider CLI 或入站 server。

### 阶段 5：常驻 Host、部署和可观测性

**依赖**：阶段 1A Provider 支持矩阵、阶段 2 账户、阶段 3 WSS/补拉。可先在本地与单 ECS staging 验证，不等平台签名。

**工作**：

1. 将 `alwaysOn` 模式连接到自托管 Agent Host 的启动/关闭、Provider pool、内存回收和服务健康状态。
2. 按支持矩阵实现 Provider 专属 resume/retry，记录 session、turn 和 receipt 状态；对错误分类和用户提示做窄 E2E。
3. 配置 ECS 仅开放必要 443/管理入口；Surface 使用主动 WSS 直连 ECS，并给 Codex/Google 分别配置代理出口及域名/IP bypass。不得改 Windows 全局代理或把 OAuth 回调送入代理。
4. 以 Surface 8 GiB 实测常驻并发（初始 1–2 turn 提案）、关键 session、Codex/Antigravity 网络 retry、Antigravity Windows 解包与临时目录；仅瞬态错误重试，不以重启 Provider 代替恢复。
5. FCM sender 运行在 Surface 当前登录用户上下文，经用户代理发送已 sealed 的提醒；服务账号私钥不进入客户端或 ECS。FCM 可达性由用户已确认的代理条件提供，本轮不探测/测试 ECS Google 连接。
6. Surface 启动策略使用当前用户登录任务/后台流程，并记录供电、唤醒、网络要求；不假设休眠/关机仍工作，也不改用户电源设置。ECS Ubuntu 由 systemd 管理。
7. 监控 ECS 账户 SQLite/日志/证书/有界转发 buffer，另行演练 Surface Host SQLite 备份/恢复；数据盘未备份验证前不碰生产数据库。

**产物**：阿里云 ECS systemd 手册、Surface Windows 用户会话启动/代理手册、监控/告警、Host 备份/恢复报告、Provider 与 FCM 故障矩阵。

**完成标准**：ECS 重启和网络中断后 Host 主动重连；Provider session 可以恢复或明确进入人工恢复状态；SQLite 可从验证过的备份恢复；网关不可达时 Host 仍保留权威数据且不丢待处理 receipt；没有 Cloudflare 凭证也可运行 staging。

### 阶段 6：集成验证、数据迁移与流量切换准备

**依赖**：阶段 2–5 的 staging 通过；阶段 4 的设备权限边界复核。

**工作**：

1. 使用窄 E2E 脚本，按仓库规则串行、最多一个 worker；脚本必须驱动真实 app/process/service，并写可复查 JSON/日志/hash 报告。
2. 故障注入：断网/切网、只允许 443、代理 timeout、ECS/Host 重启、ACK 丢失、重复消息、游标过期、文件分块中断、grant 撤销、终端断线/重连/取消/输出过载、Provider 错误与 Host 磁盘告警；检查命令不重放、buffer 有界、orphan 清理。
3. 在 Surface 走代理测试 Codex/Google/FCM，在同一 Host 检查 `api/connect`、ECS IP 和 localhost/OAuth 回调按计划绕过代理；ECS 不测 Google/FCM 出站。Android17 Pixel 测通知权限、FCM token 轮换/撤销和普通网络通知；Xiaomi 测后台限制。强制停止、Google 不可达和省电情形只记录 OS 行为，不设及时到达承诺；厂商推送可后续评估。
4. 在 Mac M2、Windows ARM64 接收端、Surface Windows x64 Host、Pixel 和 Xiaomi 实测；核对 Mach-O/PE/Android ABI、PTY 和 native 依赖确为原生架构。验证 Windows ACL、macOS Full Disk Access、桌面授权后无逐文件/命令弹窗；系统拒绝/未提权访问仍失败。
5. 核验账户数据导入计数、会话/成员授权、ticket `audience`、撤销 epoch、对象 hash、SQLite journal integrity、sealed notification/FCM sender 位置、日志脱敏、备份恢复和回退路径。
6. 只有 staging 检查完成后才生成生产迁移/切换 runbook；执行真实数据迁移、DNS 切换、删除 Cloudflare 资源或宣布迁移完成前，提交具备校验值的具体变更并等待用户明确授权。

**产物**：按平台/网络列出的 E2E 报告、事件丢失/重复清单、数据核对报告、回退演练和生产变更说明。

**完成标准**：验证结果覆盖下方验收矩阵；不满足的项标注阻塞原因和复现证据，不以“计划支持”写成已支持。生产切换之前保留原账户/数据和有效回退路线。

### 阶段 7：多架构客户端签名构建与发布 Gate

**依赖**：阶段 6 staging 证据、目标用户提供的服务域名和各平台签名资料。

**工作**：

1. CI 独立产出 Mac ARM64 客户端、Windows ARM64 纯客户端、Windows x64 Agent Host 和 Android17 包；检查 Mach-O/PE/ABI 及 PTY/native 依赖。不得以 x64 转译冒充 Windows ARM64；保留独立 Windows x64 Host 构建。
2. 在 Mac M2 验证 arm64 包签名/公证/安装升级；在 Windows ARM 设备验证原生 arm64 客户端，在 Surface 验证 x64 Host；在 Pixel 与 Xiaomi Android17 验证 package ID、keystore、SAF 和通知路径。
3. Firebase 项目由用户在 Android package ID 定稿后创建并注册 App；`google-services.json` 可随客户端发布，FCM service account 仅注入 Surface sender。验证 Surface 代理可发送、ECS 不持有 sender key 或调用 Google；通知只带 sealed payload。
4. 检查每个平台独立产品 ID、服务 URL、自动更新 manifest、更新证书和回滚版本，确保客户端不会安装宿主功能或串入官方更新通道。
5. 发布前读取 `.agents/skills/release-upgrade-safety/SKILL.md`，完成升级、数据目录和回滚审计。

**产物**：签名安装包、软件物料/版本记录、更新通道配置、平台实机验证记录和发布说明草稿。

**完成标准**：Mac ARM64、Windows ARM64 客户端、Windows x64 Host 和 Android 包身份/架构/签名/更新源均与矩阵匹配；M2、实际 Windows ARM 设备、Surface、Pixel、Xiaomi 完成对应实机安装及授权/恢复检查。Linux CI 不能证明任何这些实机已验证。发布仍需用户针对具体版本明确授权。

## 验收目标（均为 proposed，未实测）

以下指标是 staging 目标，需在阶段 0 校准，并在阶段 6 测量。健康网络定义为设备 DNS 可用、出站 TCP 443 可达、服务域名证书有效、账户/Host 服务处于健康状态；运营商封锁、系统挂起、设备关机或用户撤销授权不计为健康网络。

| 指标 | Proposed 目标 | 测量方式与限制 |
|---|---|---|
| 初次或切网恢复 | 健康网络下，95% 的在线客户端在链路可用后 5 秒内重新建立认证 WSS；P99 不超过 15 秒。 | Mac/Windows/Android 各在 Wi-Fi 与蜂窝/受限网络测量 DNS、TLS、ticket、WSS upgrade 分段时间。Android 后台被挂起时从 OS 允许调度之时开始计时。 |
| 仅 443 可用 | 禁用直连 WebRTC 并封锁非 443 出站后，登录、RPC、消息事件和小文件仍能工作。 | ECS staging + 受控防火墙/HTTPS 代理；视频不纳入 WSS 首版范围。 |
| 消息确认与重复 | 已返回 Host 持久化 receipt 的消息，进程/网络重启后仍在 SQLite；重复提交 100 次只产生一个逻辑 turn。 | 以 clientMessageId、receipt、host turn ID 和 SQLite 记录数比对；同时注入 ACK 丢失。该目标依赖数据盘未损坏。 |
| 事件恢复 | 日志窗口内游标重连不漏事件；过期游标在 15 秒内进入 snapshot 补齐（健康网络、规定的数据量范围内）。 | 记录 last-acked、last-sent、snapshot epoch、差距与耗时；超出窗口只承诺从权威快照收敛，不承诺逐条旧事件回放。 |
| 长断线数据 | 客户端待发项保持至 Host 写入 receipt 或用户主动取消；事件增量按 7 天/1 GiB 上限保留。 | 模拟应用/Host 重启、日志上限、游标过期及应用数据清除。数据清除、设备丢失、磁盘损坏不在保证内。 |
| 文件传输 | 完成文件的最终 SHA-256 与发送端一致；断线续传不会错写、越权或重复生效。 | 注入 chunk 重排、重复、丢失、撤销 grant、Host 进程重启和边界大小。 |
| 权限撤销 | grant 撤销提交后 1 秒内拒绝新资源请求；活跃请求尽最大努力取消，并留下脱敏审计事件。 | 同时注入客户端离线；离线设备恢复后不得执行旧 grant 请求。1 秒目标需由阶段 0 检查传播设计后确认。 |
| 桌面设备授权 | 单次绑定后可读写/管理当前 OS 用户权限内文件；无逐文件/命令弹窗，无 ACL/TCC 绕过或 UAC/sudo 提权。 | Mac M2 验证 Full Disk Access 行为；Windows ARM64 验证 ACL；撤销后 Host 拒绝请求。 |
| 终端恢复 | 断线时若原 shell 活着且 session 可验证，则恢复同一 session；若客户端/OS 已重启则返回结束/未知，永不重放命令。 | 记录 operation ID、输出游标、退出码；测量 1 MiB/session、4 session buffer 上限及 30 分钟孤儿清理提案。Android shell 不设首版验收要求。 |
| 原生架构 | 接收端运行原生 Mac ARM64/Windows ARM64 客户端；Surface 继续使用 Windows x64 Host。 | 检查 Mach-O/PE、ABI、PTY 和全部 native 依赖，再分别实机安装；x64 翻译不计为 ARM64 通过。 |
| 代理与 FCM | Surface 的 Codex/Google/FCM 出站走用户代理，ECS HTTPS/WSS/IP 和 localhost OAuth callback 直连；Pixel 可收到 sealed FCM 提醒。 | 按逐 CLI 目的地和 bypass 检查；ECS 不调用 Google。普通可达网络下测 Pixel token/权限和 Xiaomi 后台限制；force-stop、Google 不可达或省电下不承诺及时通知。 |
| Provider 恢复 | 瞬态网络错误持续保留 session/turn 状态；24 小时后升级告警并继续低频重试。认证撤销/凭证错误暂停并提示处理。 | Codex app-server 与 Antigravity ACP 分别记录；不支持 session resume 的 Provider 明确降级，不盲目重放 turn。 |
| 常驻 Host | 连续 7 天 staging 运行无意外休眠或 silent session loss；内存回收后恢复 ID 和任务状态可追踪。 | 记录进程、Provider session、RSS、重启次数、任务 receipt 和健康检查；不等于所有 Provider 永远驻留进程内。 |

## 需用户提供的信息

以下仅列仍未知的信息；个人用途、Surface 配置、CLI OAuth、桌面全文件/终端授权、允许使用 api/connect 子域及 Android 17 目标均已确认，不重复询问。

1. **带宽与 DNS**：200 Mbps 是标称上限，不保证跑满；用户认为可能不按流量计费但尚未核实。需确认计费项/费用上限和现有 DNS 记录；`feitu.net.cn` 网站保留，`api`/`connect` 子域可用但此轮不改记录。
2. **原生设备信息**：Windows ARM64 接收端的具体芯片/OS、Xiaomi 机型、Mac M2 的 macOS 版本；Surface 实际 `x64` 架构与 Codex/Antigravity CLI 版本需在 Host 上确认。代理可达已由用户确认，实施时逐 CLI 核对代理与直连 bypass。
3. **Firebase/FCM**：Android package ID 定稿后由用户创建 Firebase 项目并注册 App。非 secret 的公开配置可随后交付；service-account 私钥只经安全渠道注入 Surface sender。Surface 代理出站已由用户确认可达，ECS Google 出站明确不可用，不探测/不配置。
4. **企业 SMTP**：已有 `feitu.net.cn` 企业邮箱；剩余 SMTP hostname、port、TLS 模式和发件地址未知。密码/令牌只经安全渠道注入。
5. **本地 API**：若启用独立 API 工具，需给出具体服务 URL、端口、method/path 范围；桌面文件/终端宽授权已定，不再询问目录/只读或逐命令确认。
6. **容量与旧数据**：个人用途已定；仍需实测活动 Provider turn/在线终端数、最大文件及事件保留预算。另需确认是否有 Cloudflare/D1/R2 数据要迁移、迁移范围、可接受停机与回退期。

凭证只通过批准的秘密管理渠道配置。规划、聊天、日志和普通 issue 只记录变量名、是否已配置及责任人，不记录密钥值，也不要求用户把密钥粘贴到聊天。

## 后续执行工作流

- 所有实现子任务使用 `gpt-6-luna`、`reasoning_effort=max`；子 agent 用 `fork_turns=none`，任务描述自包含并列出输入、输出和验收条件。
- 先完成阶段 0 安全/协议/兼容设计门。通过后，阶段 1A Provider、1B ECS 骨架、1C 产品边界可独立并行；共享协议/schema/product config 等边界文件串行修改。
- 实现 agent 完成后，由独立 Luna/max reviewer 按计划与源码复核；修复后生成窄 E2E 证据和阶段报告。主 agent 协调依赖、审查报告并收集缺失的用户配置，不把常规阶段完成设成额外人工批准点。
- 遵循根 `AGENTS.md`：只为业务路径增加窄 E2E 脚本，不加普通单元测试；检查串行运行、最多一个 worker。仅对受影响 workspace 做必要类型检查；不本地运行广域构建/全套件。
- 本计划执行范围不含自动 commit、PR、真实账户数据切换、ECS 生产部署或发布。已有用户授权范围内的本地代码工作可以自动推进；破坏性数据动作和真实生产发布须先形成具体方案，再取得相应明确授权。
- 每阶段状态以可复查产物更新，不因草案、脚手架或模拟器成功将后续阶段标成完成。PolyForm Noncommercial 1.0.0 保持不变。
