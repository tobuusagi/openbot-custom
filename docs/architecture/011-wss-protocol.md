# ADR 011 附录：WSS 端到端协议草案

> **状态**：审查草案，未批准产品实现。此文档只定义待审查的身份角色、状态流和容量边界；在独立 Luna/max 安全审查通过之前，禁止产品 WSS E2E 握手、密文帧或 key management。仅允许使用生成身份、无业务数据和生产凭证的隔离库 feasibility spike。
> **关联**：[主 ADR](011-client-ecs-adr.md) 与 [Plan 011](../../plans/011-client-ecs-resilience.md)。

## 安全目标与不变量

- Caddy 在 ECS 终止 TLS/WSS。TLS 保护 client-to-gateway 连接，但不阻止 gateway 读取 TLS 内明文；因此聊天、文件、终端/API 操作需另外端到端加密。WebRTC DTLS 也不会自动保护 WSS。
- 网关只负责票据校验、目标路由和有界转发。它不得签发身份、扩大授权、伪造 Host/device、解密业务 payload 或持久保存聊天/终端正文。
- Account API 的短期 ticket 负责 user、Host、device、role、capability、协议版本、`authEpoch`、grant epoch、密钥指纹和过期时间。ticket 校验与 E2E 身份验证是两道边界；ticket 不替代设备 grant。
- 端点授权始终由 Agent Host/接收设备验证。设备 grant 的撤销、权限和当前 OS 身份不能由 gateway 的路由票据单独决定。
- 信任边界：账户签名根留在受信 ECS，不新增外部署名根；该设计不抵抗 ECS-root compromise。账户根可签发账户授权并影响撤销/路由。端点独立持有的 Host/device 身份私钥和 Host 本地 grant 限制 relay 进程单独伪装 peer 或解密/执行业务，但不能消除受信账户根被攻陷的风险。
- 安全 library 负责握手、KDF、AEAD、counter/nonce 和 rekey。禁止手写密码学、复用 nonce、用 TLS-only 模式降级或自造签名封装。

## 节点身份与配对

### 角色

- **Client Initiator**：Mac/Windows/Android 的纯客户端。即使它的 WSS socket 主动连入 ECS，也在逻辑 E2E 握手中作为 initiator。
- **AgentHost Responder**：Surface 的 Host 身份/服务。它自己的 WSS socket 也主动连 ECS；WebSocket 的建立顺序不改变密码学角色。
- **Gateway Relay**：验证短期路由票据并转发 opaque frames。relay 的 `from/to`、route ID 和包长都是提示信息，不能当作授权或 peer 身份证明。
- **Account Control Plane**：创建 user/host/device membership、ticket 和 revoke epoch 的服务，部署在 ECS；账户签名根是受信根。账户签名材料与 relay 进程分开保存/运行不构成对 ECS-root compromise 的防护承诺。

### 身份与 pinning 方案（待独立审查）

1. Host 与每台客户端创建各自新的持久 libp2p peer identity；身份私钥只留在对应 OS 用户的安全存储/受控目录，不交给 gateway。不要为 Noise 从既有 Ed25519 seed 派生 X25519 secret，也不强行迁移/转换当前 peer key；Noise 库须用其支持的签名身份 binding 将 DH key 绑定到 peer identity。
2. 首次配对同时要求 Host 本地 owner 操作和 OOB 核对：展示 Host 与设备的身份 fingerprint/短认证串，双方确认后各自保存并 pin 对端 peer identity；Host 本地 grant 保存设备 identity、Host/user、capability ceiling、`grantEpoch`。一次性 challenge 绑定两端 fingerprint 和过期时间，重用或过期均拒绝。ticket、账户 API 或 relay 响应不能自动创建或扩大该 grant。
3. Noise `XX` 和 `@chainsafe/libp2p-noise@17.0.0` 是隔离 spike 候选，不是已选生产协议。WSS-1 由独立 spike 用生成身份、无业务数据或生产凭证收集库/API 与目标 runtime 兼容证据；可用隔离 harness，不要求完整纯客户端先构建。何种证据足以放行本地协议适配由独立 reviewer 决定；实际 Mac/WinARM/Android 设备仍需发布验收。不能改用手写 Noise，也不能把 pinning/握手说成已批准。
4. 已配对后，relay 单独持有外层路由不能冒充被 pin 的端点或解密业务帧。身份 rotation 必须由旧 identity 签署 handover 并经端点 grant 验证，或重新执行 owner/OOB 配对；account/gateway 更新本身不得替换 pin。每次轮换的重叠窗口和撤销次序需在复审前定稿。
5. 新的持久 `grantEpoch` 随单设备 grant 变更；账户 `authEpoch` 随账户/成员权限变更。ECS durable revoke outbox 是快速传播渠道；Host 同时按下述授权 lease 检查 freshness。断线 Host 不声称已实时撤销，过期授权不能被 relay ticket 延长。

## 握手/建链草案

以下是协议角色和状态，不是可直接编码的握手字节格式；Noise library 参数、transcript、key encoding 与身份目录签名都由独立审查确定。

1. Client 与 Host 分别向自有账户 API 获取短期、限 audience 的路由 ticket/授权 lease。签名根由受信 ECS 账户控制面持有。lease 绑定 user、membership、Host、device peer fingerprint、Host 本地 grant、capability 集、`authEpoch` 和 `grantEpoch`；私钥不进入 ticket。ECS-root compromise 不在本设计的防护范围。
2. 两端通过 `/v1/relay` WSS 443 向 gateway 注册。gateway 校验票据签名/过期/基本 route scope，创建有时限、容量受限的双向 relay；Host 不接受任意未授权 peer route。
3. Client 请求到特定 Host/device grant 的 E2E session。gateway 转发初始 handshake bytes；Client 核对已 pin 的 Host fingerprint，Host 核对已 pin 的 device peer identity、当前用户成员、Host 本地 grant 与 capability/epoch。
4. 仅在库选型和协议审查通过后，成熟 Noise 标准库负责互相认证和会话密钥导出。每次重连重新握手并产生新密钥；握手失败、fingerprint 不符、版本不支持或 epoch 已变均拒绝连接，不降级到明文。
5. 应用协议的请求/事件均在加密 payload 内。gateway 仅转发外层 routing envelope，不把 relay ACK 当成 Host 持久化 receipt。认证、握手完成和消息已写入 Host SQLite 是不同状态。

### 待独立审查的安全问题

- Noise `XX` 成熟实现与 peer identity binding：选定精确库版本/API、认证 transcript、Electron macOS/Windows ARM64 和真实 Android runtime 兼容、前向保密与 key compromise recovery。隔离 spike 只提供证据，不是生产审查批准。
- Host-local owner/OOB pairing 是否防止控制面/gateway 替换身份，双向 fingerprint 的呈现与核对，peer identity rotation 和旧 key 撤销顺序。
- Host offline 时 grant revoke/`authEpoch` 的陈旧度与授权 lease 时序；新 lease、旧会话和离线设备重连的拒绝次序。
- Gateway 完全恶意时的 host/device impersonation、route substitution、frame replay/reorder/drop、流量分析及 metadata 泄漏。
- Noise rekey/session lifetime、跨重启 counter reset、并发 session、旧 generation 迟到帧与 key zeroization。
- 证书/票据私钥与 E2E identity signing key 的隔离，日志、崩溃报告与代理配置是否可能泄密。

未对以上逐项形成书面结论并被独立 Luna/max reviewer 接受，WSS data/crypto 实现不得开工。不可由作者自行将本 gate 标记通过。

## 加密帧、路由与 epoch

Gateway 外层只包含满足转发需要的版本、短期 route/session handle、目标端点 handle、payload length 和密文 bytes。外层字段即使遭改写，也不能授权操作；peer 从端到端加密 inner envelope 验证 sender identity、Host ID、device ID、grant ID、channel、sequence、generation 与 request ID。

Host 在持久状态中为每个 stable Host identity 保存单调 `hostEpoch`，并在每次 Host 进程启动时、接受远端连接前先原子递增。每次成功握手生成新的随机 `connectionGeneration`。若 hostEpoch 状态回滚/丢失，停止远程服务并要求 Host identity owner/OOB 重新配对；不复用旧 key/counter。设备重启/重置另推进本地 `deviceEpoch`，由设备验证终端进程身份。

建议逻辑 inner envelope：

```text
EncryptedEnvelope {
  protocolVersion, sessionId, authEpoch, grantEpoch, hostEpoch, deviceEpoch,
  connectionGeneration,
  senderIdentity, recipientIdentity, capability, grantId,
  channel, sequence, ackCursor?, requestId?, operationId?, ciphertext
}
```

具体字段编码和哪些元数据保持外露要由安全审查定稿。废弃/过期 epoch 的帧丢弃；sequence 重复或倒退拒绝；`requestId`/`operationId` 在业务层幂等，不以 packet ACK 推断业务动作完成。Grant epoch 更新即关闭旧 grant 的数据/terminal/API channels。

客户端重连先恢复身份与 Host/device epoch，再按授权域游标同步。每个游标按 `(host, user, device, grant, capability, hostEpoch)` 隔离，并携带/校验当前 `authEpoch` 和 `grantEpoch`；事件必须先做 membership、grant、capability、OS 权限过滤，再编号或推进 cursor。权限/epoch 改变使旧 cursor 失效并要求新授权快照。旧 generation 迟到帧不得覆盖新状态。Provider turn 状态不明时查询原 turn/session；不能通过重放 terminal command 或有副作用的 turn 来“恢复”。

## 回执、事件补拉与主库原子性

使用三种独立确认：

1. **Transport ACK**：peer 已收到密文 frame；不代表已授权、持久化或执行。
2. **Host receipt**：请求经授权且对权威 SQLite 提交成功。客户端 outbox 收到 receipt 后才标记“Host 已接收”；相同 `clientMessageId`/request ID 重放返回原 receipt。
3. **Turn/result 状态**：Provider/工具执行结果按 turn/task ID 更新，不能与接收消息 receipt 混同。

Host 只在授权检查及 `openbot.db` 中权威 receipt 与幂等键同一事务提交后，返回“Host durable receipt”。事件增量提案保留 7 天或 1 GiB（先达者）；超窗、游标缺口无法修复或 hostEpoch 改变则返回 `snapshot-required`，再从 Host SQLite 重读权威状态。ECS 不保存 chat event backlog。

独立 sidecar 与 `openbot.db` 不是同一个原子事务。任何 sidecar 只能是可丢弃/可重建的 hint/index，不能提供 ACK、游标权威或完整性承诺。若要保证每次主库提交都产生可补拉 event，须在同一 `openbot.db` 事务写 outbox 并走迁移 gate，或提出另一个经证明的原子方案。崩溃矩阵至少覆盖主库提交前/后、sidecar hint 前/后与 ACK 前、游标清理/快照并发。

授权 freshness 使用签名 lease，最长 TTL 180 秒，每 60 秒尝试刷新；lease 绑定账户 `authEpoch`、设备 `grantEpoch`、Host/device 身份与 capability 集。一次临时刷新失败时，只要当前 lease 未过期且没有收到更新 epoch/revoke，即可继续现有授权并后台重试；不能因单次网络失败直接切断仍有效会话。lease 到期或观察到更高 epoch/revoke 后立即 fail closed，拒绝受保护的文件、终端、API、聊天和事件操作，直至获得匹配当前授权状态的新 lease。durable revoke outbox 是快速通知通道，不替代 lease expiry 检查。

## 容量与 HTTP/WSS 443

- Caddy 终止 TLS，在 443 提供 `/v1/auth` 与 `/v1/relay` 等 HTTPS/WSS 路由，保留 WebSocket upgrade、长连接 timeout、streaming、背压和优雅 close。具体 path 仍在版本化 schema review 决定。
- 首版目标是 WSS 443 可承载 RPC/events/文件流。WebRTC 可用时保留既有路径；可选 TURN 用独立 coturn UDP/TCP/TLS 端口（例如 3478/5349），不能把 TURN 当普通 HTTP 443 proxy。
- 提议 encrypted frame ≤1 MiB；文件流 chunk ≤256 KiB；每连接待转发 buffer ≤1 MiB；ECS 全局在线转发 buffer ≤128 MiB。达到上限时背压或拒绝新传输，不将整文件缓存到内存/磁盘、不把消息持久排入 gateway。
- 在 2 GiB/2 vCPU ECS staging 实测后设置连接数、队列数、单用户速率、超时和磁盘硬上限。200 Mbps 是标称最大值而非保证；不能对连接数或吞吐量作固定承诺。
- 文件分块按 offset/total length/hash 校验；重连只续传已授权对象/epoch。审计只记 request ID、大小、状态和路由元数据，不记文件名、正文、命令、token 或代理凭证。

## Capability payload 和终端状态

- `client-device-files-v1`：用户已对配对桌面 grant 全文件能力；Host 端只在该设备当前用户授予的 ACL/TCC 权限内执行。设备文件路径属于设备端，不能解释为 Host 路径。
- `client-device-terminal-v1`：提案消息 `OPEN_SESSION`、`EXEC(operationId, requestHash)`、`INPUT`、`OUTPUT(cursor)`、`RESIZE`、`CANCEL(operationId)`、`EXIT(status)`。授权命令在被授权执行的 Mac/Windows 接收端以当时登录的 OS 用户身份运行；它不是 Host 本地进程，也不自动提权。API URL allowlist 不限制已授权终端 shell。
- 执行设备必须在 spawn 前将 `(operationId, requestHash, state=reserved)` 写入本机持久 ledger；相同 ID/hash 返回保存状态，不同 hash 拒绝。Host SQLite 可持久确认“已接收/待设备执行”及编排状态，但不能确认远端命令已启动/完成。执行设备再用 `deviceEpoch`、进程 ID、进程启动时间与 session identity 验证同一原 shell；仅该进程仍活且身份可证时才附着。设备/客户端重启后无法证明原进程时返回 `ended` 或 `unknown`，绝不重跑。spawn 与记录进程身份之间崩溃也按 `unknown` 处理。
- 初始内存上限提案：接收设备拥有每 session 1 MiB 输出 ring，最多 4 session，设备侧合计 4 MiB；Host 编排进程另拥有每 session 1 MiB 暂存、合计最多 4 MiB；relay 只拥有每连接最多 1 MiB buffer、全局最多 128 MiB。任何一层达到上限都施加背压并显式报告输出缺口/阻止更多输出，不能把缓冲写入网关磁盘。WSS 断开后最多 30 分钟可附着；每个 ring 由所属进程释放，设备端记录负责判断输出 cursor 是否仍可恢复。数值由实机压力测试校准。
- `client-device-local-api-v1`：独立且严格 allowlist 的服务/port/method/path/body；不把 API adapter 扩展成任意代理。Android SAF/App 权限与可选 App sandbox terminal 不继承桌面宽授权。

## Review 和未实现项

独立审查通过条件：选定成熟握手库及标准 pattern；pair bootstrap、Host pin、device key、revoke 和 rotation 的数据流闭环；恶意 gateway 下不能冒充 peer 或篡改业务身份；nonce/replay/rekey/epoch 行为由 library 与协议共同保证；帧和文件流容量上限可安全背压；event sidecar 没有未解决的权威性/原子性承诺。

本草案没有线格式、密码库选择结论、测试向量或实现代码。安全审查失败或缺少身份/bootstrap 证据时保持 WSS E2E 停止；Surface 的 Provider 常驻原型、本地 SQLite adapter 和 ECS HTTP 骨架可独立继续。
