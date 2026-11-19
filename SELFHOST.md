# 飞兔的 OpenBot 自建账号服务

基于 nightly-labs/openbot v0.74.0（PolyForm Noncommercial，仅个人自用）。
只改了 `apps/auth-api/wrangler.jsonc`，其余与官方 v0.74.0 一致。

## 改动
- 路由：`api.feitu.dpdns.org`（custom domain）
- SMTP：阿里云企业邮箱 smtp.qiye.aliyun.com:465（SSL）。邮箱地址不进仓库，在 CF 里填
- Signal：`wss://signal.feitu.net.cn/v1/signal`，回调 `https://signal.feitu.net.cn/internal/auth-events`
- 关掉托管服务器、多 Signal 节点、GitHub App、APNs、计费国家校验
- 去掉官方专用的 email relay service 和 send_email 绑定
- D1 不写 database_id，部署时由 wrangler 自动创建/绑定 `openbot-auth`

## 部署方式：GitHub Actions（.github/workflows/deploy-auth-api.yml）
构建需要 7GB 以上内存，所以不用 Cloudflare 自带构建，改用公开仓库的 Actions（16GB）。
1. 仓库 Settings → Secrets and variables → Actions，加两个：`CLOUDFLARE_API_TOKEN`（模板“编辑 Cloudflare Workers”，再加 D1 编辑权限）、`CLOUDFLARE_ACCOUNT_ID`
2. 仓库 Actions 页启用工作流，手动运行 “Deploy auth-api to Cloudflare”
3. 第一次部署后，到 CF 把下面的 Secret 填好，再运行一次

## Worker Secrets（在 CF 的 Worker → 设置 → 变量和机密 里填，绝不进 Git）
- `EMAIL_SMTP_USERNAME`、`EMAIL_FROM`：阿里云企业邮箱地址
- `EMAIL_SMTP_PASSWORD`：该邮箱的三方客户端安全密码（邮箱设置→账户与安全→三方客户端安全密码）
- `SKILLS_ADMIN_TOKEN`、`SITE_REPORT_HASH_SECRET`、`REMOTE_AUTH_WEBHOOK_SECRET`：各用 `openssl rand -base64 48`
- `REMOTE_TICKET_PRIVATE_JWK`、`REMOTE_TICKET_PUBLIC_JWKS`：用 docs/self-hosting.md 第 1 步的命令生成，kid 用 `self-hosted-1`

## R2
需要先在 CF 控制台开通 R2，并建三个桶：`openbot-avatars`、`openbot-skills`、`openbot-sites`。
