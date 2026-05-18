<!--
- [INPUT]: BotCord already has a Web Dashboard, Hub control plane, local daemon, and a Tauri desktop shell for daemon lifecycle.
- [OUTPUT]: Design for embedding the Web Dashboard into the macOS/Linux desktop app while keeping Hub as the primary bridge to daemon business capabilities.
- [POS]: Product and engineering plan for the first Tauri + embedded Dashboard implementation.
- [PROTOCOL]: Update when desktop WebView routing, deep-link auth, install-token flow, or local bridge APIs change.
-->

# Desktop Embedded Dashboard Design

## 背景

BotCord 目前有三层核心能力：

```text
Web Dashboard
  |
  | HTTPS API
  v
Hub
  |
  | daemon control websocket
  v
local botcord-daemon
  |
  v
local runtimes / gateways / agents
```

Web Dashboard 不直接操作用户电脑。绝大多数产品功能已经通过 Hub 转发到 daemon：

- 创建和配置 agent；
- provision agent；
- gateway 管理；
- policy / memory / runtime files；
- daemon 在线状态和 runtime snapshot；
- room、chat、message 等业务功能。

因此桌面 App 不应该重新实现 Dashboard，也不应该让 Web 直接拥有任意本机命令能力。桌面 App 的价值主要是：

1. 让用户用 DMG/AppImage 安装并打开一个“完整入口”。
2. 在 App 内访问 Web Dashboard。
3. 在 daemon 尚未启动、尚未授权、尚未托管时，提供本地 bootstrap/lifecycle 能力。
4. daemon 在线后，业务能力继续走现有 Hub 控制链路。

## 目标

1. macOS App 内嵌 `https://botcord.chat` Dashboard，形成接近原生桌面 App 的体验。
2. 保留现有 Hub 作为 Dashboard 到 daemon 的主要 bridge。
3. Tauri local bridge 只暴露最小本机生命周期 API。
4. 支持首次授权：

```text
打开 BotCord.app
App 内 Dashboard 登录
Dashboard 生成一次性 install-token
回传给 Tauri local bridge
Tauri 调 botcord-daemon start --install-token
daemon 写入 user-auth.json
Dashboard 看到 daemon online
用户选择 Install Service
launchd/systemd 托管 daemon
```

5. 支持普通浏览器和桌面 WebView 共用同一套 Dashboard 代码。

## 非目标

- 不把 Hub control plane 替换成本地 bridge。
- 不允许 Web Dashboard 执行任意 shell 命令。
- 不让远端网页直接读写任意本地文件。
- 不在 `launchd` / `systemd` service 文件中保存 `install-token`。
- 第一版不做完整离线 Dashboard。Dashboard 仍依赖线上 Hub。
- 第一版不把 Next.js 整站打包成本地静态站，优先加载线上 Dashboard。

## 推荐架构

```text
BotCord.app (Tauri)
  |
  +-- Local Shell
  |     |
  |     +-- Tauri commands
  |           - daemon status/start/stop/restart
  |           - connect with install-token
  |           - install/uninstall launchd or systemd service
  |           - tail local daemon logs
  |
  +-- Dashboard WebView
        |
        +-- https://botcord.chat
              |
              +-- Hub APIs
              +-- Hub daemon control websocket
              +-- optional desktop bridge calls only for bootstrap/lifecycle
```

Dashboard 业务页面继续按现在方式请求 Hub。只有 install/reconnect 相关页面需要知道自己是否运行在桌面 App 内。

## 页面结构

桌面 App 第一版建议采用两栏或 tab：

```text
BotCord.app
  - Dashboard
  - Local Daemon
  - Logs
  - Settings
```

### Dashboard

内嵌线上 Dashboard：

```text
https://botcord.chat
```

Dashboard 内部保留现有路由：

- `/chats`
- `/settings/daemons`
- `/settings/policy`
- `/agents/add`
- 其他产品页面

### Local Daemon

本地生命周期页：

- daemon 状态；
- logged in / not logged in；
- Hub URL；
- daemon instance id；
- Start / Stop / Restart；
- Connect to BotCord；
- Install Service / Uninstall Service。

### Logs

只读展示：

```text
~/.botcord/logs/daemon.log
```

第一版 tail 最近 100-200 行即可，不做完整 log viewer。

### Settings

配置：

- `botcord-daemon` 路径；
- Hub URL；
- Dashboard URL；
- device label。

本地配置存储：

```text
~/.botcord/desktop/config.json
```

## 本地 Bridge 边界

Tauri 只暴露白名单命令。

建议第一版 API：

```ts
desktop.getConfig(): Promise<DesktopConfig>
desktop.saveConfig(config): Promise<void>

desktop.daemon.status(): Promise<DaemonStatus>
desktop.daemon.start(opts): Promise<string>
desktop.daemon.stop(): Promise<string>
desktop.daemon.restart(opts): Promise<string>

desktop.auth.openConnectPage(opts): Promise<string>
desktop.auth.connectWithInstallToken(opts): Promise<string>

desktop.service.status(): Promise<ServiceStatus>
desktop.service.install(opts): Promise<string>
desktop.service.uninstall(): Promise<string>

desktop.logs.tail(): Promise<string>
```

这些 API 映射到当前 Tauri commands：

```text
get_config
save_config
get_daemon_status
start_daemon
stop_daemon
restart_daemon
open_connect_page
connect_with_install_token
get_service_status
install_service
uninstall_service
tail_logs
```

明确不提供：

```text
exec(command)
readFile(path)
writeFile(path)
deleteFile(path)
```

如果未来需要选择文件或目录，应增加专门的受限 API，例如：

```ts
desktop.pickCredentialsFile()
desktop.openLogsFolder()
```

而不是开放通用文件系统能力。

## Dashboard 如何识别桌面环境

Dashboard 需要在浏览器和 Tauri WebView 中共用。

建议在 Dashboard 前端做一个很薄的 adapter：

```ts
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
```

然后封装本地能力：

```ts
export const desktopBridge = {
  available(): boolean,
  version(): Promise<string | null>,
  daemonStatus(): Promise<DaemonStatus | null>,
  connectWithInstallToken(input): Promise<string>,
  installService(input): Promise<string>,
};
```

普通浏览器里：

- `available()` 返回 false；
- 页面继续显示 curl 安装命令或 deep-link 安装流程。

桌面 WebView 里：

- install/reconnect 页面显示 “Connect this device”；
- 调用 Tauri bridge 完成本地启动；
- 业务页面仍走 Hub。

## 授权流程

### 现有 DMG deep-link 流程

当前已实现的外部浏览器流程：

```text
BotCord.app
  -> open https://botcord.chat/desktop/install?callback=botcord://install&hub=...
Dashboard
  -> POST /api/daemon/auth/install-ticket
  -> botcord://install?install_token=...&hub=...
BotCord.app
  -> botcord-daemon start --background --hub ... --install-token ...
daemon
  -> POST Hub /daemon/auth/install-token
  -> write ~/.botcord/daemon/user-auth.json
```

这个流程仍然保留，作为外部浏览器和安装引导兜底。

### 内嵌 Dashboard 流程

当 Dashboard 已经在 BotCord.app WebView 中运行时，可以减少一次 deep-link 回跳：

```text
Dashboard /desktop/install
  -> POST /api/daemon/auth/install-ticket
  -> desktopBridge.connectWithInstallToken({
       hubUrl,
       installToken,
       label
     })
  -> desktopBridge.daemonStatus()
  -> show connected
```

注意：`install-token` 仍然只存在于内存中，只用于一次 `botcord-daemon start --install-token`。不写入：

- Dashboard localStorage；
- Tauri config；
- launchd plist；
- systemd service 文件。

### 登录态

Dashboard 登录态仍是 Web 登录态：

```text
Supabase cookie / OAuth session
```

daemon 登录态仍是本地 daemon auth：

```text
~/.botcord/daemon/user-auth.json
```

二者通过一次性 install-token 绑定，但不是同一个凭证。

## Service 托管流程

授权完成后，用户可以点击 `Install Service`。

macOS：

```text
~/Library/LaunchAgents/chat.botcord.daemon.plist
```

启动命令：

```text
botcord-daemon start --foreground --hub https://api.botcord.chat
```

Linux：

```text
~/.config/systemd/user/chat.botcord.daemon.service
```

启动命令：

```text
botcord-daemon start --foreground --hub https://api.botcord.chat
```

service 文件不带 `--install-token`。daemon 使用已有：

```text
~/.botcord/daemon/user-auth.json
```

## 安全模型

### 来源限制

如果 App 内嵌线上 Dashboard，local bridge 只应该对可信 origin 开启：

```text
https://botcord.chat
https://preview.botcord.chat
http://localhost:<dev-port>       # dev only
```

第一版可以先在 UI 层只加载配置里的 Dashboard URL。后续应在 Tauri command 层增加调用来源校验，避免任意 WebView 页面调用本地命令。

### API 白名单

Bridge 必须是能力白名单，不提供任意命令执行。

允许：

- daemon lifecycle；
- service lifecycle；
- install-token redeem；
- log tail；
- config read/write。

禁止：

- 任意 shell；
- 任意文件读写；
- 长期 secret 持久化；
- 将 install-token 写入 service 文件。

### Token 处理

`install-token` 是 bearer secret。约束：

- Hub 只签发短期、一次性 token；
- Desktop 只在内存中接收；
- Desktop 立即传给 daemon；
- daemon 兑换成功后写正式 daemon auth；
- Desktop 不保存 install-token。

## 版本兼容

线上 Dashboard 会快于桌面 App 更新，因此 bridge 需要版本能力。

建议增加：

```ts
desktopBridge.info(): Promise<{
  appVersion: string;
  bridgeVersion: number;
  capabilities: string[];
}>
```

示例：

```json
{
  "appVersion": "0.1.0",
  "bridgeVersion": 1,
  "capabilities": [
    "daemon.status",
    "daemon.start",
    "daemon.stop",
    "auth.installToken",
    "service.install",
    "logs.tail"
  ]
}
```

Dashboard 根据 capability 决定 UI：

- 有 `auth.installToken`：显示桌面连接按钮；
- 没有：显示 deep-link 或 curl 兜底；
- 有 `service.install`：显示 Install Service；
- 没有：显示手动命令。

## 实施计划

### Phase 1: 内嵌 Dashboard Shell

目标：App 里出现 Dashboard tab。

实现：

1. Tauri 增加 Dashboard WebView 或 iframe-like route。
2. 默认加载 `https://botcord.chat`。
3. 保留 Local Daemon 页面。
4. Settings 支持 Dashboard URL。

验收：

- App 内可以登录 Dashboard；
- Dashboard 页面可正常导航；
- 外部浏览器仍可使用 Dashboard。

### Phase 2: Desktop Bridge Adapter

目标：Dashboard 可检测桌面环境，但业务功能仍走 Hub。

实现：

1. frontend 新增 `src/lib/desktop-bridge.ts`。
2. 封装 Tauri `invoke`。
3. 普通浏览器下返回 unavailable。
4. Dashboard daemon install/reconnect UI 根据 bridge 可用性切换。

验收：

- 浏览器中仍显示 curl/deep-link；
- App WebView 中显示 desktop connect；
- 无 bridge 时不报错。

### Phase 3: 内嵌授权闭环

目标：App 内完成 daemon 首次授权，不跳外部浏览器。

实现：

1. `/desktop/install` 页面检测 desktop bridge。
2. 已登录时请求 `/api/daemon/auth/install-ticket`。
3. 调用 `connectWithInstallToken`。
4. 成功后刷新 daemon status。
5. 引导用户安装 service。

验收：

- 新机器打开 App 登录后可直接连接 daemon；
- `~/.botcord/daemon/user-auth.json` 写入成功；
- `launchd` service 文件不包含 install-token。

### Phase 4: Service and Health UX

目标：把本机状态和 Hub 状态合并展示。

实现：

1. Local Daemon 页显示：
   - local pid；
   - service installed/active；
   - daemon auth；
   - Hub online/offline。
2. Dashboard `/settings/daemons` 中显示本机增强操作。
3. 失败时给出明确恢复动作：
   - daemon missing；
   - auth expired；
   - service failed；
   - Hub unreachable。

验收：

- 用户能判断“本地没启动”还是“Hub 显示离线”；
- 一键重连能覆盖常见失败。

### Phase 5: Release Hardening

目标：可正式分发。

实现：

1. macOS code signing。
2. notarization。
3. auto-update 策略。
4. Linux AppImage/deb CI。
5. bridge origin enforcement。
6. bridge capability versioning。

## 文件和模块建议

Desktop：

```text
desktop/src/main.tsx
desktop/src/styles.css
desktop/src-tauri/src/lib.rs
desktop/src-tauri/tauri.conf.json
```

Frontend：

```text
frontend/src/lib/desktop-bridge.ts
frontend/src/app/desktop/install/page.tsx
frontend/src/app/desktop/install/DesktopInstallClient.tsx
frontend/src/components/daemon/*
frontend/src/components/dashboard/*
```

Docs：

```text
docs/desktop-embedded-dashboard-design.md
```

## 开放问题

1. App 内嵌 Dashboard 使用单 WebView 还是多 WebView？
   - 单 WebView 简单；
   - 多 WebView 可把 Local Daemon 和 Dashboard 隔离更清楚。

2. Dashboard URL 是否允许用户自定义？
   - prod 用户默认 `https://botcord.chat`；
   - preview/dev 需要可配置。

3. OAuth 在 WebView 中是否完全采用内嵌登录？
   - 如果 provider 阻止 WebView 登录，需要回退到系统浏览器 + deep-link。

4. bridge origin enforcement 放在哪一层？
   - 前端 UI 层不够；
   - 最好 Tauri command 层校验 WebView URL。

5. 是否需要 tray/menu bar？
   - 第一版可以没有；
   - 后续可增加 daemon status 和 quick actions。

6. App 是否应该内置 daemon 二进制？
   - 当前依赖 `~/.botcord/bin/botcord-daemon` 或 PATH；
   - 更傻瓜的发行版可以把 daemon 打进 App bundle，再由 App 安装/更新。

## 结论

推荐采用：

```text
Tauri + embedded Web Dashboard + minimal local lifecycle bridge
```

其中：

- Hub 继续是 Web Dashboard 到 daemon 业务能力的主 bridge；
- Tauri local bridge 只负责 Hub 天然无法完成的本机 bootstrap/lifecycle；
- install-token 仍然是一次性短期凭证，不持久化；
- daemon 启动并授权后，Dashboard 继续沿用现有 Hub control plane。

这个方案能最大化复用现有 Web 产品能力，同时把桌面 App 的权限面控制在最小范围内。
