# Human 用户旅程验收修复 — 设计文档

**日期**：2026-04-23  
**分支**：基于 main  
**范围**：方案 B — 修复 F1/F2/F3/B1 + 后端单测

---

## 背景

本文档记录对 5 条 Human 用户旅程验收清单的 gap 分析结果，以及对应的修复设计。大部分旅程已实现；本次修复仅针对验收发现的 4 个 gap。

---

## Gap 清单

| ID | 旅程 | 文件 | 问题描述 |
|----|------|------|----------|
| F1 | J4 | `RoomHumanComposer.tsx` | placeholder 由 `activeAgent` 是否存在决定，不读 `viewMode`；切回 Human 模式后仍显"替 Agent·Name 发言…" |
| F2 | J5 | `PendingApprovalsPanel.tsx` | 所有 UI 文案硬编码英文，不走 zh/en i18n 体系 |
| F3 | J1/J2 | `ChatPane.tsx` | `buildVisibleMessageRooms` 调用不传 `humanRooms`；`authed-no-agent` 有 human 房间时右侧主区误显 RoomZeroState |
| B1 | J5 | `backend/app/routers/humans.py` | `resolve_pending_approval` 从 payload 读 `from_type`，A2A 路径 payload 无此字段，默认 `"human"`；approve 后 Contact 的 `peer_type` 写错 |

---

## 修复设计

### B1 — 后端：`resolve_pending_approval` from_type 推断

**文件**：`backend/app/routers/humans.py`，函数 `resolve_pending_approval`

**修复逻辑**：若 payload 无 `from_type` 字段，从 `from_participant_id` 的 ID 前缀推断：

```python
from_pid = payload.get("from_participant_id")
from_type_raw = payload.get("from_type")
if from_type_raw and from_type_raw in {p.value for p in ParticipantType}:
    from_type = ParticipantType(from_type_raw)
elif from_pid and from_pid.startswith("ag_"):
    from_type = ParticipantType.agent
elif from_pid and from_pid.startswith("hu_"):
    from_type = ParticipantType.human
else:
    from_type = ParticipantType.human
```

**影响**：仅改变 A2A 发起的 contact_request 审批行为；Human BFF 发起的审批 payload 带有 `from_type`，走原有分支，行为不变。

---

### F1 — 前端：`RoomHumanComposer` placeholder 尊重 viewMode

**文件**：`frontend/src/components/dashboard/RoomHumanComposer.tsx`

**修复**：placeholder 改为由 `viewMode` + `activeAgent` 联合决定：

```tsx
const placeholder = (viewMode === "agent" && activeAgent)
  ? (locale === "zh"
      ? `替我的 Agent · ${activeAgent.display_name} 发言…`
      : `Speak on behalf of Agent · ${activeAgent.display_name}…`)
  : (locale === "zh"
      ? `作为 ${displayName} 发言…`
      : `Message as ${displayName}…`);
```

**行为**：
- `viewMode="human"`（无论 activeAgentId 是否有值）→ 显示"作为 <Name> 发言…"
- `viewMode="agent"` + activeAgent 存在 → 显示"替 Agent·Name 发言…"

---

### F2 — 前端：`PendingApprovalsPanel` i18n

**文件**：
- `frontend/src/lib/i18n/translations/dashboard.ts`（或同目录翻译文件）— 新增 `pendingApprovalsPanel` 键组
- `frontend/src/components/dashboard/PendingApprovalsPanel.tsx` — 用 `useLanguage()` + 翻译键替换硬编码字符串

**需翻译字符串**：
| key | en | zh |
|-----|----|----|
| `title` | "Approvals on your agents" | "待审批请求" |
| `subtitle` | "External requests directed at agents you own — approve or reject on their behalf." | "外部对你名下 Agent 发起的请求，代理审批。" |
| `refresh` | "Refresh" | "刷新" |
| `approve` | "Approve" | "批准" |
| `reject` | "Reject" | "拒绝" |
| `loading` | "Loading pending approvals…" | "加载中…" |
| `forAgent` | "for" | "目标 Agent：" |

---

### F3 — 前端：ChatPane 传入 humanRooms

**文件**：`frontend/src/components/dashboard/ChatPane.tsx`

**修复**：在 ChatPane 的 `useDashboardSessionStore` selector 中取出 `humanRooms`，并传给 `buildVisibleMessageRooms`：

```tsx
const { sessionMode, token, humanRooms } = useDashboardSessionStore(useShallow((state) => ({
  sessionMode: state.sessionMode,
  token: state.token,
  humanRooms: state.humanRooms,
})));

const visibleMessageRooms = useMemo(
  () => buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms }),
  [overview, recentVisitedRooms, token, humanRooms],
);
```

**效果**：`authed-no-agent` 用户有 humanRooms 时，主区显示"从左栏选择房间"提示而非 RoomZeroState。

---

## 后端测试

**文件**：`backend/tests/test_app/test_app_humans.py`（追加）

**测试用例**：`test_a2a_contact_request_approval_creates_correct_contacts`

步骤：
1. 注册 `external_agent`（无 user 绑定）
2. 注册 `claimed_agent` 并绑定到 `user_a`
3. `external_agent` 通过 `/hub/send` 发 `type=contact_request` 给 `claimed_agent`
4. 断言 `agent_approval_queue` 有 `state=pending` 记录，`kind=contact_request`
5. 以 `user_a` 身份调用 `POST /api/humans/me/pending-approvals/{id}/resolve {"decision":"approve"}`
6. 断言返回 `{"state": "approved"}`
7. 断言 Contact 表有两行：
   - `owner_id=claimed_agent, contact_agent_id=external_agent, peer_type=agent`
   - `owner_id=external_agent, contact_agent_id=claimed_agent, peer_type=agent`

---

## 不在范围内

- 新增前端 Vitest 测试（项目无前端测试套件约定）
- J3 Human 建群（已由 commit 805446f 修复）
- Realtime/WebSocket 层变更
- 旧用户（authed-ready）体验变更

---

## 验收标准（对应旅程）

| 旅程 | 验收点 |
|------|--------|
| J1 | 登录无 Agent → /chats/messages，无 AgentGateModal，purple badge，`sessionMode=authed-no-agent` |
| J2 | 有 human 房间 → Sidebar 显示，打开房间 → RoomHumanComposer 显示，placeholder 正确，乐观气泡，红色报错 |
| J3 | 建房成功后新房间立即出现在 Sidebar（已修复） |
| J4 | 切到 Agent → badge 青色，placeholder"替 Agent·Name 发言…"；切回 Human → badge 紫色，placeholder"作为 <Name> 发言…" |
| J5 | A2A contact_request → approval_queue pending；批准 → 双向 Contact(peer_type=agent)；拒绝 → state=rejected；面板中英文均正常显示 |
| 回归 | authed-ready 用户体验不变；Ed25519 签名正常；unclaimed agent auto-accept 不变 |
