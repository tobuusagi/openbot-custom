# Plan 011：受控本地 WSS development adapter 规格

> **版本**：`011-wss-dev-v1`（2026-11-05）  
> **状态**：实现提案，未获独立安全审查批准。本文只授权范围描述，不自行关闭任何 WSS 安全 gate。  
> **关联**：[WSS 协议草案](011-wss-protocol.md)、[独立安全审查](011-wss-security-review.md)。

## 范围和通过证据

2026-11-05 隔离实验记录了 memory-only harness 在 Node、Bun、Chromium 三个 runtime 合计 36/36 通过，以及 Node 24 loopback WebSocket harness 7/7 通过。后者使用生成身份，在 `127.0.0.1` 上以真实 TCP/WebSocket 承载 `@chainsafe/libp2p-noise@17.0.0` 的 Noise XX 握手和双向密文记录，并验证新 session、旧 session 密文拒绝、错身份与篡改拒绝。报告位于忽略目录 `.openbot-build/011-noise-spike/loopback-websocket-report.json`。

证据支持下一步提出一个**受控、纯本地、无产品数据**的 adapter。它不代表独立审查批准，也不证明身份持久化、授权 lease、数据库事务、设备能力或公网 relay。产品 WSS E2E、账户票据、真实用户身份、Host/device 持久 key、产品数据、文件/终端/API 操作、真实 ECS 或生产密钥仍不得接入。

本地 adapter 的边界固定为：

- 两个由本地测试进程启动的端点，只绑定 `127.0.0.1` 的临时端口；HTTP WebSocket，无 TLS，无 DNS、网关、反向代理、Cloudflare 或外网依赖。
- Client 是 Noise Initiator，Host 是 Responder。WebSocket 建立顺序不改变角色。仅使用 `Noise_XX_25519_ChaChaPoly_SHA256` 和精确 pin 的 `@chainsafe/libp2p-noise@17.0.0`；禁止自行实现握手或从 TLS 降级。
- 私钥和测试用户/Host/device ID 由 harness 生成。默认仅内存存活；测试结束销毁。adapter 不读取 OpenBot 用户配置、`openbot.db`、真实登录态、代理配置或系统 keychain。
- 使用本地 fake account/lease issuer 和独立临时数据库，内容全部为 fixture。fake issuer 只能签发限定测试 ID 的 lease，不能被产品服务信任。
- 不执行 terminal 命令，不访问文件/API，不回放 Provider turn，不声称消息幂等或离线恢复已实现。
- 使用独立的 `openbot-wss-dev` 协议名和版本字段；不复用、不扩展、不改变任何已发布 Team API 的 wire meaning、schema 或 capability。

## 身份、配对与存储接口

### Noise 身份绑定

两端使用各自新生成的 Ed25519 libp2p peer identity。Noise 库在握手中签署其临时 X25519 static key 与该 peer identity 的 binding。连接时双方都必须传入预期 `remotePeer`，并在握手后再次比较已验证的 remote peer ID 与已 pin 的 ID。身份不匹配、binding 签名失败、握手超时或 epoch 不符均关闭 socket 和 Noise stream；不得自动重试成未认证连接。

本地 adapter 使用 ephemeral identity，验证 peer-ID pinning 和 Noise signed binding 的程序路径。它没有生产持久身份，也没有证明 OS key storage。

### 双向 owner/OOB 配对

配对状态机为 `unpaired → challenge-issued → both-confirmed → pinned`。Host owner 在 Host 端启动 challenge；设备 owner 在设备端启动同一 challenge。双方屏幕均显示各自完整 peer fingerprint（peer ID 原始字节的 SHA-256、小写 base32）和相同的 6 位短认证串：

```text
digest = SHA-256(CBOR-deterministic([
  "openbot-011-pair-v1", challengeId, hostPeerId, devicePeerId, grantId, expiresAt
]))
shortCode = zeroPad(decimal(first4Bytes(digest) as uint32 mod 1_000_000), 6)
```

短串只方便当面或独立语音核对，不代替 full fingerprint。双方分别确认相同短串和对端 fingerprint，缺一即拒绝。challenge 至多有效 5 分钟，随机 256-bit `challengeId`，成功消费后原子标记 used；重放、过期、身份变化或任一方撤回均拒绝。配对创建的 grant 初始仅含实验允许的 capability，不能由 ticket/lease 增权。

受控 adapter 可用两个本地 CLI 窗口模拟两个 owner 的确认步骤，但必须让两端独立输入短串并确认 peer ID；自动接受、共享一个确认布尔值或跳过 OOB 的路径不算配对证据。它只验证状态机，不证明远程用户界面或真实 owner 授权。

### 存储抽象

后续 adapter 应只依赖下列接口；密码库私钥不得通过普通 getter 导出：

```ts
interface IdentityKeyStore {
  createIdentity(scope: IdentityScope): Promise<PeerIdentity>;
  getPeerId(identityId: IdentityId): Promise<PeerIdBytes>;
  sign(identityId: IdentityId, domain: string, bytes: Uint8Array): Promise<Uint8Array>;
  deleteIdentity(identityId: IdentityId): Promise<void>;
}
interface PeerPinStore {
  read(scope: IdentityScope): Promise<PinnedPeer | undefined>;
  commitPairing(pairing: ConfirmedPairing): Promise<void>;
  commitRotation(rotation: ConfirmedRotation): Promise<void>;
  revoke(scope: IdentityScope, nextGrantEpoch: bigint): Promise<void>;
}
interface MonotonicEpochStore {
  advanceBeforeListen(scope: IdentityScope): Promise<bigint>;
  read(scope: IdentityScope): Promise<bigint>;
}
```

`IdentityScope` 是 `(accountId, hostId, deviceId, role)`。实现必须保证 epoch 的 durable atomic increment；发现缺失、回滚、损坏或 restore 到旧值时拒绝启动远程服务并要求 owner/OOB 重新配对。OS 实现分别需证明 macOS Keychain、Windows CNG/DPAPI 和 Android Keystore 的用户绑定、备份/恢复、锁屏及删除语义。当前没有这些平台 adapter 的证据。

有限本地模型允许注入 `MemoryIdentityKeyStore`、`MemoryPeerPinStore`、`MemoryEpochStore`，显式标注为进程寿命模型；它只能验证状态转移，不能满足持久 identity、重启 epoch 或任何产品身份要求。不得把 JSON 私钥文件、环境变量或测试 fixture 描述为安全存储。

### Rotation 和撤销顺序

Rotation 不设置两把 key 同时可用于新 session 的宽限期：

1. 新身份生成但保持 inactive。旧身份以 domain `openbot-011-rotation-v1` 签署 handover；新身份也签署同一 canonical payload。payload 包含 scope、old/new peer ID、grant ID、`oldGrantEpoch`、`newGrantEpoch = old + 1`、256-bit nonce、5 分钟以内 expiry。
2. Host owner 以 OOB 核对新 peer fingerprint，并确认本地 grant ceiling 不增加。Host 在一个原子持久提交中写入新 pin、next epoch 和 handover nonce 已消费状态。
3. 提交成功后，先拒绝任何旧 `grantEpoch` 的新操作并关闭旧 session，再宣布新身份 active。顺序不允许旧、新会话同时授权写操作。
4. 账户/设备撤销先在控制面原子递增对应 `authEpoch` 或 `grantEpoch` 并写 durable revoke outbox；Host 收到后先本地持久写入撤销 epoch，再关闭受影响 session、清除 lease 和拒绝请求，最后回执 revoke 已应用。控制面不得把 relay ACK 当成 Host 已撤销。
5. lease 到期前未收到 revoke 只表示仍在其签名 scope/TTL 内；TTL 到期即 fail closed。设备离线期间，Host 不得声称已在该离线设备上清除本地数据或终止本地 OS 进程。

旧 key 丢失、handover 签名不全、nonce 重用或持久提交不确定时，不做自动 fallback；owner 必须重新完成双向 OOB 配对，旧 grant 先撤销。

## 本地 wire schema `011-wss-dev-v1`

以下 schema 只供本地 fixture 使用。adapter 在 Noise stream 内发送严格 canonical CBOR；WebSocket 只搬运 Noise library 输出的 binary bytes，不自行添加协议明文头、路由身份或 ack。不得改变 libp2p Noise record framing。

CBOR 使用 RFC 8949 deterministic/canonical encoding：整数最短编码、byte string 精确长度、map key 按 canonical 顺序；拒绝重复 key、未知 key、非 canonical encoding、trailing bytes、indefinite-length item、NaN/float 和超过边界的值。顶层为 map，key 为下表 unsigned integer。必填字段全部存在；条件字段仅允许相应 message type 使用。

| key | 字段 | 编码/限制 |
|---:|---|---|
| 0 | `version` | uint，固定 `1` |
| 1 | `type` | uint enum：`1=HELLO`、`2=HELLO_ACK`、`3=HELLO_CONFIRM`、`4=CHAT_REQUEST`、`5=HOST_RECEIPT`、`6=EVENT`、`7=TERMINAL_STATE`、`8=CURSOR_REQUEST`、`9=SNAPSHOT_REQUIRED` |
| 2 | `sessionId` | 16-byte string，由 Responder 在 Noise 握手完成后随机生成，随后经 Noise 加密保护发送 |
| 3 | `hostId` | 16-byte stable opaque fixture ID |
| 4 | `userId` | 16-byte fixture ID |
| 5 | `deviceId` | 16-byte fixture ID |
| 6 | `hostPeerId` | byte string，1–128 bytes；必须等于本地 pinned peer ID |
| 7 | `devicePeerId` | byte string，1–128 bytes；必须等于本地 pinned peer ID |
| 8 | `grantId` | 16-byte string |
| 9 | `authEpoch` | uint64，单调递增 |
| 10 | `grantEpoch` | uint64，单调递增 |
| 11 | `hostEpoch` | uint64，本次 Host 启动前原子递增值 |
| 12 | `deviceEpoch` | uint64，本次设备启动前原子递增值 |
| 13 | `generation` | 16-byte string，由 Responder 与 `sessionId` 一同生成，经 Noise 加密保护发送；本地为单一 Host/device session 使用同一 tuple |
| 14 | `capability` | uint：`1=chat`、`2=files`、`3=terminal`、`4=local-api`；本地 chat harness 只允许 1 |
| 15 | `channel` | uint enum：`1=control`、`2=chat`、`3=files`、`4=terminal`、`5=local-api` |
| 16 | `sequence` | uint64，从 0 起，每方向每 session 单调连续递增 |
| 17 | `cursor` | optional uint64，仅 cursor/event/snapshot 类型可用 |
| 18 | `requestId` | optional 16-byte string；有副作用或 receipt 的请求必填 |
| 19 | `operationId` | optional 16-byte string；terminal state 必填 |
| 20 | `body` | byte string，类型化 body 的 canonical CBOR；最大 786,432 bytes |

完整应用 envelope 最大 1 MiB；任何实现都需对应用层有界重组，在超过该值时关闭 session。此上限不代表 Noise 单条 record 或单次 `send` 的大小，也不应被直接设为库 record 上限。adapter 必须按精确库 API 遵守 Noise record 长度和分片要求；WS binary message 边界不是 Noise record 边界，接收端须按序把 binary payload 作为 byte chunks 喂给有界 stream adapter，并正确处理跨 WS message 的 record/应用数据。一个 `sendData` 产出的 bytes 由本地 adapter 映射到一个 WebSocket binary message 是传输实现选择，不证明所有 record 大小、分片或 1 MiB 单次 library send 已验证。WS message 限长必须同时容纳所用库合法的最大 record；该值须从精确库 API/实现确认，不能由 1 MiB envelope 上限推导。压缩关闭；不接收 text frame。文件 body 单 chunk 最大 256 KiB；一连接待处理总量最大 1 MiB；本地 harness 无全局 relay。产品提案的 ECS 全局转发上限仍是 128 MiB，须在 ECS staging 测量后校准。

Noise 握手完成后，Responder 独立生成随机 `sessionId` 与 `generation`，并在加密 stream 上发 `HELLO`，内容包括 tuple、`protocolName="openbot-wss-dev"`、版本范围、Host/device/user/grant scope、四个 epoch 和 peer fingerprints。该 tuple 不是两端各自生成后再猜测匹配。Initiator 校验 Host pinned identity、全部 scope/epoch/版本及自己的 device identity，然后发送 `HELLO_ACK`，逐字节回显同一 tuple 与 scope。Responder 比较一致后发送 `HELLO_CONFIRM` 回显该 tuple，表明已收到并接受 ACK。控制 sequence 固定为：Responder `HELLO=0`，Initiator `HELLO_ACK=0`，Responder `HELLO_CONFIRM=1`；这组控制 sequence 与应用 sequence 分开。Initiator 收到且验证 CONFIRM 后认为建链完成；Responder 发出 CONFIRM 前也已验证 Initiator 的 ACK。双方在此之前只允许这些三种控制消息，任何业务帧均关闭 session。CONFIRM 后两方向应用 sequence 都分别从 0 开始。之后每帧均须匹配当前 Noise `sessionId`、双方 ID、身份 scope、grant 和 epoch、generation、capability/channel 组合。一个字段错配即关闭，不尝试在不匹配字段上找接近的 session。

CONFIRM 后发送端按方向独立从 `sequence=0` 开始；接收端每个 direction/session 期望值初始为 0，精确匹配后加一。小于该值视作 replay，大于该值视作缺帧/乱序；两者都关闭当前 session，不能跳过或恢复计数。HELLO 阶段的控制消息不使用此应用计数。Noise library 自己管理 AEAD nonce、record counter 与 rekey；应用层 sequence 供协议关联和拒绝，不得转作 nonce。

## Lease、epochs 和拒绝次序

签名 lease 的最大有效期 180 秒；客户端在签发后 60 秒尝试 refresh。签发者必须签名并绑定 `userId`、membership、`hostId`、Host peer ID、`deviceId`、device peer ID、`grantId`、capability 精确集合、`authEpoch`、`grantEpoch`、`issuedAt`、`expiresAt` 和 audience。Host 不能用票据替代本地 grant；两端有效权限是 account membership、Host 本地 grant、lease capability 与 OS 权限的交集。

refresh 临时失败时，仍在有效期内且 scope 完全一致的旧 lease 可继续有限使用；指数退避重试。验证到更高 epoch 或 revoke 后立刻关闭受影响 channels，清除旧 lease。lease 到期且未取得匹配新 lease 时，聊天写、文件、终端、API、事件补拉和 cursor 推进全部 fail closed。失败/无效的 refresh 不延长 TTL、不扩 capability。

Host 与 device 各自在接受连接前递增自己的持久启动 epoch。连接成功时分配新随机 `generation`。session 需同时匹配所有四个 authorization/boot epochs、pinned peers、grant、capability 和 generation。重启恢复后旧 generation 永远无效。状态库缺失、回滚或读写不确定即不监听/不接受远程操作；本地内存模型只能断言该拒绝分支，不能宣称完成了 durable 防回滚。

## Receipt、终端状态和 cursor 规则

### Chat receipt 与 `openbot.db`

Host receipt 仅针对已经被 Host 授权并写入权威聊天存储的 chat request。产品实现必须在同一个 `openbot.db` SQLite transaction 中写权威消息和唯一 `clientMessageId`/`requestId` receipt；只有 COMMIT 成功后才可发 `HOST_RECEIPT`。同 ID、同 request hash 返回原 receipt；同 ID、不同 hash 拒绝。WebSocket/Noise 送达 ACK、gateway ack、设备本地 outbox 都不能替代它。

受控本地 adapter 可以用新的临时 fixture SQLite DB 演示一个 transaction 和唯一键。严禁连接、迁移或读写用户的 `openbot.db`；没有在产品主库中实现该 transaction 的证据，不得描述为产品 receipt 已实现。临时 DB 在 harness 关闭时删除。

`TERMINAL_STATE` 只允许状态值 `reserved`、`started`、`running`、`exited`、`ended`、`unknown`。Host receipt 表示 Host 接受了操作记录，不表示设备 spawn、完成或成功。产品设备必须在 spawn 前将 `(operationId, requestHash, deviceEpoch, state=reserved)` 持久提交；不确定 spawn 与记录之间的崩溃标记 `unknown`。只在已记录 PID、OS process start time、terminal session identity 和当前 `deviceEpoch` 全部匹配时 attach。ID/hash 相同返回保存状态；ID 相同而 hash 不同拒绝。重启后状态不明一律 `unknown`，禁止重放命令。30 分钟断连上限到期关闭仍受控的 session 并记最终状态或 `unknown`；不承诺系统关机时的进程终止。

本地 adapter 不 spawn 任意命令，最多验证一个假的 ledger 状态机和 duplicate/no-replay 决策；terminal execution、OS ledger 和进程 reattach 仍属产品阻塞项。

### 授权过滤与 cursor

cursor 域精确为 `(hostId,userId,deviceId,grantId,capability,hostEpoch,authEpoch,grantEpoch)`。Host 先检查 membership、Host-local grant、capability、当前 lease、epoch 和 OS permission，再从该授权范围的事件集合编号并返回；未授权事件不消耗或推进该设备 cursor，防止游标旁路泄漏事件数量。授权/epoch 变化立即使旧 cursor 失效并返回 `SNAPSHOT_REQUIRED`；snapshot 只包含新范围允许的状态，随后开启新 cursor。游标越界、缺口无法修复、Host epoch 变化或授权信息缺失均 fail closed，不尝试从 gateway 补数据。

产品 cursor 的权威事件必须由 Host 主库事务写入；sidecar 只能是可重建索引。该方案可能需要 `openbot.db` schema/migration 和崩溃矩阵，未获另行范围审查前不实施。

## 范围门、capability 和背压

受控本地第一步仅开放 `chat` capability 和空白 fixture 内容。files、terminal、local-api enum 用来确保未知/未授权 capability 拒绝，不能触发任何 OS I/O。Control、chat 之外的 channel 一律拒绝。授权判断发生在 body 解码/业务 dispatch 前；不满足 grant/lease/epoch 时关闭或返回固定拒绝码，不能将内容转交其他处理器。

产品容量提案保留：完整加密 envelope ≤1 MiB，文件 chunk ≤256 KiB，每连接待处理 relay buffer ≤1 MiB，ECS 全局 online relay buffer ≤128 MiB。relay 只内存转发，不写盘，不保存离线消息。达到每连接或全局上限时停止读取/施加 backpressure；若无法及时 drain，关闭该传输并返回 `RESOURCE_EXHAUSTED`，不得静默 drop 后继续推进 cursor。此行为还需公网/ECS staging 压测；loopback 通过不证明吞吐或全局上限正确。

## WSS-1 至 WSS-6 状态映射

| Gate | 本规格新增的闭合材料 | 仍未闭合/允许进入本地 adapter 的范围 |
|---|---|---|
| WSS-1 library/pattern | 精确本地候选为 `@chainsafe/libp2p-noise@17.0.0`、Noise XX、Client Initiator、Host Responder；Node/Bun/Chromium memory harness 合计 36/36 与 Node loopback 7/7 证据路径已记录。 | 仅支持受控本地适配器提案。独立 reviewer 仍须审查实现 API、transcript、signed binding、license/runtime；macOS ARM64、Windows ARM64、Android 实机留发布前验证。作者不得判定批准。 |
| WSS-2 identity/pairing | 双向 OOB、一次性 challenge、pin、接口、无重叠 rotation 和撤销顺序已定稿为待实现规则。 | 真实 UI、OS 安全存储、持久 grant、平台恢复/删除尚无证据。local adapter 可用内存模型验证状态机，不可接真实账户或身份。 |
| WSS-3 trust | 明确 ECS account root 是信任根，不声称抵御 ECS-root compromise；Host-local grant 限制 relay 单进程权限的设计要求保留。 | 实际 ECS process/key isolation 未验证。local adapter 无 ECS、无公网 relay，不能给出生产信任证据。 |
| WSS-4 frame/replay/epoch | 定义 canonical CBOR map、字段/大小、strict sequence、session/generation/epoch 校验与 restart fail-closed 次序。 | 当前实验只证明 Noise 旧密文与 tamper 拒绝；CBOR parser、durable monotonic epoch、防 rollback、恶意 gateway 行为尚未验证。local adapter 可用 fixture model 测规则，不持久化产品 state。 |
| WSS-5 lease/cursor | 定稿 180 秒 lease、60 秒 refresh、revocation/expiry 拒绝顺序以及授权过滤后 cursor 域。 | 真实账户签名 lease、跨进程 revoke、Host offline freshness 和产品 cursor 没有实现/证据。local fake issuer 只演示有限状态转移，不能连接 auth API。 |
| WSS-6 receipt/terminal/capacity | 区分 Noise transport、Host DB receipt 和 device execution；规定 `openbot.db` 同事务、terminal `unknown`/no replay、cursor 和容量上限。 | 产品主库迁移、设备 ledger/OS process identity、终端执行、ECS 背压/压测和 sidecar crash matrix 未完成。adapter 只能用临时 DB 和无副作用 ledger fixture。 |

完成本地 adapter 不会改变[独立审查的否决结论](011-wss-security-review.md)，不关闭 WSS-1 至 WSS-6，也不授权产品协议、账户集成、生产部署或任何真实设备能力。后续每个 gate 必须由审查者依据对应证据独立关闭。
