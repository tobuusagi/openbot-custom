# openbot-custom 构建文档

本 fork 的定制构建流程（Windows x64 NSIS 为主）。已在 Linux 构建机实测通过。

## 环境

- Bun 1.4.2
- Node.js 24
- wine（NSIS 打包需要；`dist:win` 会在 wine 里跑安装器做冒烟测试）

首次构建前：`bun install`

## 构建 Windows x64

```bash
bun run dist:win
```

产物：`dist/OpenBot-<version>.exe`（NSIS 安装包）。

`package:win` 是更严格的版本（多做完整校验），日常用 `dist:win` 即可。

## 关键：自动更新已彻底关闭

`electron-builder.yml` 里提交了 `publish: null`。

原因：fork 的 `package.json` 中 `repository` 仍指向 `nightly-labs/openbot`，
不显式关闭的话，electron-builder 会从官方仓库拉更新，把定制版覆盖掉。
（只删 publish 段落不够，它会从 repository 字段反推 GitHub 地址，必须写 `null`。）

将来如需自建更新通道，再把 `publish` 指到本仓库的 releases。

## 签名

自签证书（CN=OpenBot Self-Sign personal，825 天有效期），私钥 `codesign.key`
权限 600 保管，不进仓库、不外传。

```bash
osslsigncode sign \
  -certs codesign.cer -key codesign.key \
  -t http://timestamp.digicert.com \
  -in dist/OpenBot-<version>.exe \
  -out dist/OpenBot-<version>-signed.exe
osslsigncode verify dist/OpenBot-<version>-signed.exe
```

目标机器安装前（管理员 PowerShell/CMD）：

```
certutil -addstore TrustedPublisher codesign.cer
```

## Windows ARM64 构建（备用）

上游无 win-arm64 的 provider CLI，且 voice / remote-desktop / cua-driver
均无 arm64 资源。构建时需**本地临时**改 `electron-builder.yml`
（不要提交，保持 x64 构建完整）：

1. `win.target` 的 `arch` 加 `arm64`（或单独 `--arm64`）
2. `win.extraResources` 置空（`extraResources: []`），跳过上述三个运行时
3. 源码已有补丁：`runtimeTarget()` 对 win32+arm64 回退到 `win32-x64`
   （x64 CLI 经 Prism 转译运行）

## 跟进上游更新

```bash
git remote add upstream https://github.com/nightly-labs/openbot.git  # 一次性
git fetch upstream
git checkout main
git merge upstream/main   # 有冲突就地解，重点看自己改过的文件
git push origin main
```

不要追着每个版本跑，挑需要的跟。同步后按上面流程重编。

## 本 fork 已提交的定制

1. `src/backend/agent/provider-runtime.ts` — provider 空闲回收阈值放宽到
   约 8.3 小时（`PROVIDER_IDLE_RELEASE_MS` / `PROVIDER_UNASSIGNED_RELEASE_MS`
   均改为 `30_000_000`）。代价：单个 unused OpenCode 进程常驻约 300MB。
2. `src/main/provider-runtime-manager.ts` — win32-arm64 回退到 win32-x64
   provider runtime（x64 上为 no-op）。
3. `electron-builder.yml` — `publish: null`，彻底关闭自动更新。
