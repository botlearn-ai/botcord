# Daemon Non-Interactive Install Token Design

## 背景

当前 dashboard 前端生成的 daemon 安装命令是：

```sh
curl -fsSL https://botcord.chat/daemon/install.sh | sh -s -- --hub https://api.botcord.chat
```

安装脚本最后会执行：

```sh
botcord-daemon start --hub <hub>
```

daemon 首次启动时如果本地没有 `~/.botcord/daemon/user-auth.json`，会进入 device-code 登录流程：daemon 向 Hub 申请 `device_code`，用户再到浏览器里确认授权。这个流程在 `curl | sh` 管道启动时会遇到 stdin 不是 TTY 的问题，也会增加一次用户交互。

目标是让从 dashboard 复制出来的安装命令自带一个短期凭证，安装后 daemon 直接完成 user auth 初始化，不再要求交互式登录。

## 结论

可以做，但不建议把长期 `refresh_token` 或完整 `user-auth.json` 直接放进 curl 命令。

推荐方案是：前端向 Hub 申请一个“一次性 daemon install ticket”，安装命令只携带这个 ticket。daemon 第一次启动时用 ticket 向 Hub 兑换正式 daemon token bundle，然后本地写入 `~/.botcord/daemon/user-auth.json`。

这相当于把现有 device-code 的 “用户 approve 后 daemon poll token” 改成 “已登录 dashboard 预先 approve，daemon 拿一次性 ticket 直接 redeem”。

## 用户体验

dashboard 展示命令：

```sh
curl -fsSL https://botcord.chat/daemon/install.sh | sh -s -- \
  --hub https://api.botcord.chat \
  --install-token dit_xxxxxxxxxxxxxxxxxxxxxxxx \
  --label "Chen MacBook"
```

用户复制运行后：

1. 安装 `@botcord/daemon`
2. 写 wrapper 到 `~/.botcord/bin/botcord-daemon`
3. 执行 `botcord-daemon start --hub ... --install-token ... --label ...`
4. daemon 调 Hub 兑换 ticket
5. daemon 写入 `~/.botcord/daemon/user-auth.json`
6. daemon 启动 control channel

整个过程不需要打开授权 URL，也不依赖 TTY。

## 安全模型

`--install-token` 是 bearer secret。拿到它的人可以把 daemon 绑定到当前登录用户账号下，所以必须限制能力和生命周期。

约束建议：

- ticket 只可使用一次。
- TTL 短，建议 10 分钟，最多 30 分钟。
- ticket 只用于创建一个 daemon instance 并兑换 daemon auth，不能调用其他 API。
- Hub 数据库只保存 token hash，不保存明文。
- 兑换成功后立刻标记 consumed。
- dashboard 重新打开或刷新安装命令时签发新 ticket，旧 ticket 可保留到过期，也可以主动 revoke。
- 命令 UI 需要提示“不要分享这条命令”。

不建议：

- 不要把 daemon `refresh_token` 放进命令。
- 不要把完整 `user-auth.json` base64 后放进命令。
- 不要让 ticket 长期有效。

原因是 shell history、终端录屏、日志系统、工单截图都可能泄露命令。一次性短期 ticket 的泄露窗口最小。

## 后端设计

新增表：`daemon_install_tickets`

字段建议：

```text
id                  text primary key              # ditk_xxx, not the token itself
user_id             uuid not null
token_hash          text not null unique
label               text null
expires_at          timestamptz not null
consumed_at         timestamptz null
created_at          timestamptz not null
daemon_instance_id  text null
```

也可以不暴露 `id`，只暴露明文 `token`，数据库通过 `token_hash` 查找。`id` 主要用于审计和 UI 展示。

### POST /daemon/auth/install-ticket

认证：dashboard 用户 Supabase JWT，走现有 `require_user`。

请求：

```json
{
  "label": "Chen MacBook"
}
```

响应：

```json
{
  "install_token": "dit_...",
  "expires_in": 600,
  "expires_at": "2026-04-28T07:30:00Z"
}
```

行为：

1. 校验当前用户已登录。
2. 生成高熵随机 token，例如 32 bytes urlsafe base64。
3. 存储 hash。
4. 返回明文 token，之后无法再次读取明文。

### POST /daemon/auth/install-token

认证：无需用户 JWT，凭 install token 本身认证。

请求：

```json
{
  "install_token": "dit_...",
  "label": "Chen MacBook"
}
```

响应复用现有 daemon token bundle shape：

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 3600,
  "user_id": "...",
  "daemon_instance_id": "di_...",
  "hub_url": "https://api.botcord.chat"
}
```

行为：

1. hash 请求里的 token，查 `daemon_install_tickets`。
2. 不存在、过期、已 consumed 都返回 401 或 410。
3. 在事务内创建 `daemon_instances` row。
4. 调用现有 `_build_token_bundle()` 签发 daemon access/refresh。
5. 保存 daemon refresh token hash 到 `daemon_instances`。
6. 标记 ticket `consumed_at` 和 `daemon_instance_id`。
7. 返回 token bundle。

实现时可以复用现有：

- `_provision_daemon_instance()`
- `_build_token_bundle()`
- `_hash_refresh_token()`
- `generate_daemon_instance_id()`

## 前端设计

当前命令由 `CreateAgentDialog.tsx` 的 `buildStartCommand()` 拼出来。需要改成异步获取 ticket：

1. 新增 BFF route：`POST /api/daemon/auth/install-ticket`
2. BFF 通过现有 `proxyDaemon()` 把 Supabase bearer token 转发到 Hub。
3. `CreateAgentDialog` 打开或用户点击刷新命令时调用该 route。
4. 用返回的 `install_token` 拼命令。

命令示例：

```ts
function buildStartCommand(token: string, label?: string): string {
  const app = APP_BASE_URL.replace(/\/$/, "");
  const hub = HUB_BASE_URL;
  const labelArg = label ? ` --label ${shellQuote(label)}` : "";
  return `curl -fsSL ${app}/daemon/install.sh | sh -s -- --hub ${hub} --install-token ${shellQuote(token)}${labelArg}`;
}
```

注意：前端拼 shell 命令时需要 shell quote，不能直接插入 label。

## daemon CLI 设计

给 `botcord-daemon start` 新增参数：

```text
--install-token <dit_xxx>
```

启动认证决策改成：

1. `--install-token` 存在：调用 Hub `/daemon/auth/install-token` 兑换 token bundle，写 `user-auth.json`。
2. `--relogin`：走现有 device-code。
3. 已有 `user-auth.json`：沿用现有逻辑。
4. 无凭证且 stdin 是 TTY：走现有 device-code。
5. 无凭证且非 TTY：继续报现有错误。

`--install-token` 的优先级应该高于已有 `user-auth.json` 还是低于已有凭证，需要明确：

推荐：如果已有凭证且没有 `--relogin`，默认忽略 `--install-token`，避免重复创建 daemon instance。若用户希望重新绑定，使用：

```sh
botcord-daemon start --relogin --install-token <token>
```

后续修正：当已有 `user-auth.json` 但 refresh 被 Hub 明确拒绝为
`invalid_refresh_token` / `daemon_revoked` 时，启动命令里携带的
`--install-token` 不应继续被忽略。daemon 应优先尝试用本地
`daemonInstanceId` 重新授权同一个 daemon instance，而不是新建 daemon instance。
否则旧设备会被保留为离线，已绑定到旧 `daemon_instance_id` 的 agents 也会继续
挂在旧设备下；新建 instance 后再批量改绑 agents 会破坏设备历史和管理语义。

期望行为：

1. 本地有 `daemonInstanceId` 且 Hub 返回 `invalid_refresh_token`：用用户授权的
   install token / device-code 为同一个 instance 重新签发 daemon auth。
2. 本地没有 `daemonInstanceId`，或旧 instance 不属于当前用户 / 已删除：才创建新
   daemon instance。
3. `daemon_revoked` 应保持终态，不自动恢复同一个 instance，除非产品明确提供
   “恢复已撤销设备”流程。

也可以新增更明确的：

```sh
botcord-daemon start --install-token <token> --replace-auth
```

第一版建议简单处理：已有凭证时打印 note 并忽略 install token。

## install.sh 设计

`backend/static/daemon/install.sh` 已经支持 `--` 后面的额外 daemon args：

```sh
curl .../install.sh | sh -s -- --hub <hub> -- --label <label>
```

但当前 `--hub` 是 install.sh 自己的参数，`EXTRA_DAEMON_ARGS` 只接收 `--` 后面的内容。为了让 dashboard 生成的命令更自然，建议 install.sh 自身也识别：

```text
--install-token <token>
--label <name>
```

然后在启动时传给 wrapper：

```sh
"$WRAPPER" start --hub "$HUB_URL" --install-token "$INSTALL_TOKEN" --label "$LABEL"
```

或者继续利用现有透传机制，前端生成：

```sh
curl -fsSL https://botcord.chat/daemon/install.sh | sh -s -- \
  --hub https://api.botcord.chat \
  -- \
  --install-token dit_xxx \
  --label "Chen MacBook"
```

推荐第一版让 install.sh 显式支持 `--install-token` 和 `--label`，命令更短，用户也更容易理解。

## 兼容性

保留现有 device-code 流程：

- 用户从非 dashboard 场景安装时仍可交互登录。
- install token 过期时，daemon 可以提示重新复制 dashboard 命令。
- 无 TTY 且无 install token 时仍然 fail fast。

旧命令仍可用：

```sh
curl -fsSL https://botcord.chat/daemon/install.sh | sh -s -- --hub https://api.botcord.chat
```

只是第一次启动仍会走现有 device-code。

## 风险与缓解

### Shell history 泄露

风险：install token 会进入 shell history。

缓解：

- ticket 一次性、短 TTL。
- UI 明确提示不要分享命令。
- 兑换成功后立即 consumed。

### 用户复制后很久才运行

风险：token 过期。

缓解：

- CLI 错误提示：`install token expired; copy a fresh command from dashboard`。
- 前端显示过期倒计时，过期后自动刷新 ticket。

### 重复运行同一条命令

风险：第二次运行 ticket 已 consumed。

缓解：

- 如果本地已有 `user-auth.json`，daemon 在兑换前先使用现有凭证，避免重复兑换。
- 如果本地无凭证但 ticket consumed，提示重新复制命令。

### CI / 服务器日志泄露

风险：命令被日志采集。

缓解：

- 文档里说明此命令等同短期登录授权。
- 如果要支持 CI，应设计单独的 service token，不复用用户 install ticket。

## 实施步骤

1. 后端新增 `daemon_install_tickets` 模型和迁移。
2. 后端新增 `POST /daemon/auth/install-ticket`。
3. 后端新增 `POST /daemon/auth/install-token`。
4. protocol-core 新增 `redeemDaemonInstallToken()` client helper。
5. daemon CLI 新增 `--install-token` 参数和兑换逻辑。
6. install.sh 新增 `--install-token`、`--label` 参数并传给 daemon。
7. frontend 新增 BFF route：`/api/daemon/auth/install-ticket`。
8. `CreateAgentDialog` 改成异步获取 ticket 并生成无交互安装命令。
9. 加测试：
   - Hub ticket 签发、过期、一次性消费。
   - daemon CLI 使用 install token 写入 `user-auth.json`。
   - install.sh 参数解析。
   - frontend route 未登录返回 401。

## 推荐默认参数

```text
DAEMON_INSTALL_TICKET_TTL_SECONDS=600
token entropy >= 256 bits
token prefix = dit_
hash = sha256(token)
```

## Open Questions

1. 已有 daemon auth 时，带 `--install-token` 是否应该强制替换？建议第一版不替换。
2. 前端是否需要每次展示弹窗都签发新 ticket？建议是。
3. install token 是否绑定 IP / UA？不建议第一版做，容易误伤用户在远端机器安装的场景。
4. 是否需要在 dashboard 上显示 pending install tickets？第一版不需要，只显示 daemon instances。
5. relogin / install-token 是否支持“恢复同一个 daemon instance”？建议支持：
   CLI 提交本地 `daemonInstanceId`，Hub 验证该 instance 属于当前用户且未 revoked，
   然后仅重发 daemon auth，不新建 instance，也不改绑 agents。
