# Surface Agent Host 启动辅助

适用环境：Surface Pro 7、Windows 11、已完成各自 CLI OAuth 登录的 Codex/Antigravity。本脚本只给用户指定的程序设置进程级 `OPENBOT_PROVIDER_LIFECYCLE=always-on`，不安装或选择 OpenBot 启动程序，也不创建新的 Host 服务。

在仓库根目录，以脚本方式调用，不要 dot-source：

```powershell
.\scripts\feitu-provider-host.ps1 -FilePath 'existing-host.exe' -DryRun
.\scripts\feitu-provider-host.ps1 -FilePath 'existing-host.exe' -CommandArgs @('--example-argument')
```

`existing-host.exe` 和参数是占位示例，必须替换为已验证的 Host 启动程序及其真实参数。DryRun 只解析程序，不启动它；工具不打印路径、参数或环境变量。正式运行前临时设置上述一个变量，结束后恢复原值，并传回原生子进程退出码。

脚本继承当前代理、TLS 和认证环境；不修改 PATH、注册表、用户/系统环境变量、计划任务或全局代理。Google/Codex 的现有代理路由与 ECS/本地 OAuth 直连策略由用户已有网络配置提供，脚本不会自动建立这些路由。

always-on 只影响已实现的 Codex/Antigravity 生命周期策略，不保证操作系统不休眠，也不取代 CLI 登录、消息恢复或公网 WSS。请勿在参数中传递密码或令牌。Windows PowerShell 5.1/7、Surface 真机与实际 Host 程序启动尚未验证；当前 Linux 环境没有 PowerShell，因此不能声称该脚本已通过执行验证。
