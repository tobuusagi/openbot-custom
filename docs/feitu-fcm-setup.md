# FCM 接入设置与验收计划

> 本文是 FCM 接入与验收计划，不代表已完成 FCM 实现、部署或真实验证。Minimax 根据任务规格起草；协调者已对照下列配置源码补充实际路径。尚未创建 Firebase 项目、构建真机应用或验证真实推送。

## 1. 目标与边界

- Android application ID：`cn.net.feitu.openbot.client`
- 构建选择：`OPENBOT_MOBILE_VARIANT=feitu-android`、`EAS_BUILD_PLATFORM=android`
- Firebase 项目：尚未创建。
- 设备：Pixel、Xiaomi Android 17。
- 未来发送端：Windows 11 Surface Agent，使用用户自行管理的 Google 代理。
- ECS 仅作网关；其环境无法访问 Google，禁止从 ECS 测试 Google/FCM。
- Surface 到 ECS 的业务流量及本地 OAuth 保持直连，不修改全局代理。
- 仅 Surface 到 Google 的流量使用用户代理。
- 私钥、服务账号凭据不得进入客户端、ECS、仓库、聊天或日志；未来通过密钥管理单独、安全地提供发送端所需凭据。
- 本次未执行部署、发信、推送或任何真实 FCM 测试。

## 2. Firebase 注册与公开配置

1. 创建或选定 Firebase 项目，登记 Android application ID `cn.net.feitu.openbot.client`。
2. 在 Firebase Console 下载应用对应的 `google-services.json`。
3. 核对 JSON 中 package 必须是 `cn.net.feitu.openbot.client`；确认无误后命名为 `google-services.feitu.json`。
4. 默认放置位置为 `apps/mobile/google-services.feitu.json`。`apps/mobile/app.config.js` 读取此文件；可用 `OPENBOT_FEITU_GOOGLE_SERVICES_FILE` 指定相对 `apps/mobile` 内的路径，禁止绝对路径和向目录外穿越。
5. 配置源码会检查 `client[].client_info.android_client_info.package_name` 包含目标包名，并拒绝复用 released 配置文件及其同目标符号链接。项目归属仍须人工确认；包名匹配不能证明属于自有 Firebase 项目。
6. 明确区分：缺少 Firebase 配置是受支持的 no-push 构建，不应导致构建或启动失败；应验证推送被优雅禁用。
7. 禁止复用 official `google-services.json`；所有使用 feitu 配置的产物只能属于登记的包名。

## 3. 客户端准备

- 现有应用已包含 Firebase 通知代码和产品配置守卫；不假设 SDK 集成全部缺失。
- 现有应用通知加密契约必须保持不变；不得新增或猜测 payload schema。
- Android 13 及以后需要运行时通知权限。权限拒绝应关闭系统通知展示，不应阻止应用其他功能或启动。
- Android 后台限制、厂商省电策略可能影响送达；通知权限与后台运行能力需分别检查。
- 缺少 Firebase 配置时，应优雅禁用推送并保持应用可用。
- 配置依据：`apps/mobile/app.config.js`；运行时产品元数据依据：`apps/mobile/src/shared/lib/mobile-product.ts`。本轮未重跑既有配置测试，原生构建及真实推送尚未验证。

## 4. 发送端后续集成

- 当前发送端集成阻塞：Firebase 项目和发送端凭据尚未就绪，本次不实现或部署发送端。
- Surface Agent 的 Google 请求使用用户管理的代理；ECS 业务流量和本地 OAuth 继续直连。
- 服务账号私钥只能从安全秘密存储注入发送进程运行时，不得写入镜像、仓库、ECS、日志或聊天。
- 不设计或记录未经仓库验证的环境变量名、凭据路径、启动命令或代理配置格式。
- 发送前应校验目标应用、FCM 发送授权和现有加密消息契约；不得在实现中另造明文协议。

## 5. 设备验收清单（全部未运行）

对 Pixel 和 Xiaomi Android 17 分别执行并记录结果：

- [ ] 安装/构建时选择 `OPENBOT_MOBILE_VARIANT=feitu-android`、`EAS_BUILD_PLATFORM=android`，并确认使用自己的 feitu 公开配置。
- [ ] 首次启动、已授予通知权限、拒绝通知权限三个场景均正常。
- [ ] 缺少 Firebase 配置的 no-push 构建可构建、可启动，推送优雅禁用，不影响其他功能。
- [ ] 前台收到符合现有加密契约的通知。
- [ ] 后台/锁屏收到通知；记录被系统或厂商限制的表现。
- [ ] 离线后恢复网络并重连，可继续工作且不重复处理。
- [ ] 发送端或服务端撤销后，后续授权获取被阻止；这不等同于撤销 Android 通知权限。
- [ ] 配置缺失、注册失败、代理失败时应用可降级且不崩溃。
- [ ] 验证 durable ordered receiving、reconnection、replay cursor、idempotency、receipt；不得仅依赖推送提示。
- [ ] 确认推送 hints 不包含消息正文、敏感文件路径或凭据。

## 6. 验收判定

- Pixel 收到真实通知的前提是该设备实际能够访问 Google 服务；不能仅凭安装成功判定可用。
- Xiaomi 的 GMS 可用性随设备、系统镜像和区域配置而变化，必须实机验证。
- 任何设备均不承诺固定送达延迟；后台、厂商策略、代理和 Google 服务状态都会影响结果。
- 推送提示只能作为唤醒/提示信号，不能替代可靠、有序、可重连、可重放、幂等且可确认接收的持久化协议。

## 7. 下一步所需输入

- 可创建/使用的 Firebase 项目标识。
- 下载的公开 Android 配置，确认包名及 Firebase 项目归属；按上述路径提供配置文件。不要提供服务账号 JSON。
- Pixel 与 Xiaomi Android 17 的可测试设备可用性。

不要在聊天中提交服务账号私钥、访问令牌或其他秘密。
## 本地公开配置检查工具

在仓库根目录运行 `python3 scripts/feitu-firebase-config-check.py --file apps/mobile/google-services.feitu.json`；可追加 `--expected-project-id <自己的公开项目ID>` 核对目标项目。工具仅本地读取指定文件，不联网、不打印文件内容或标识。它拒绝私钥配置、重复 JSON 键、错误包名和超限文件；结果为 valid 也不证明项目所有权或真实推送可用。不要用此工具收集或提交服务账号密钥。
