# Human 用户旅程验收修复 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 5 条 Human 用户旅程验收清单中的 4 个 gap（F1/F2/F3/B1），B1 配套回归测试。

**Architecture:** B1 修复后端 `resolve_pending_approval` 的 from_type 推断逻辑（从 ID 前缀推断，不再硬默认 human）；F1 修复 RoomHumanComposer placeholder 不读 viewMode；F2 为 PendingApprovalsPanel 补 zh/en i18n；F3 在 ChatPane 补传 humanRooms 给 buildVisibleMessageRooms。

**Tech Stack:** Python 3.12 / FastAPI / pytest-asyncio / PyNaCl（后端），Next.js 16 / React 19 / TypeScript / Zustand（前端）

---

## 文件清单

| 操作 | 路径 |
|------|------|
| 修改 | `backend/app/routers/humans.py` |
| 修改（追加） | `backend/tests/test_app/test_app_humans.py` |
| 修改 | `frontend/src/components/dashboard/RoomHumanComposer.tsx` |
| 修改（追加） | `frontend/src/lib/i18n/translations/dashboard.ts` |
| 修改 | `frontend/src/components/dashboard/PendingApprovalsPanel.tsx` |
| 修改 | `frontend/src/components/dashboard/ChatPane.tsx` |

---

## Task 1: [B1] 后端 from_type 推断修复 + 回归测试（TDD）

**Files:**
- Modify: `backend/app/routers/humans.py:538-540`
- Modify: `backend/tests/test_app/test_app_humans.py`（末尾追加）

- [ ] **Step 1: 在 test_app_humans.py 顶部 import 区追加依赖**

在文件已有 `import uuid` 等行之后追加：

```python
import base64
import hashlib
import time

import jcs
from nacl.signing import SigningKey
```

- [ ] **Step 2: 在 test_app_humans.py 末尾追加三个辅助函数**

```python
def _make_keypair() -> tuple["SigningKey", str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify_agent(
    client: "AsyncClient", sk: "SigningKey", pubkey_str: str, display_name: str
) -> tuple[str, str, str]:
    resp = await client.post(
        "/registry/agents",
        json={"display_name": display_name, "pubkey": pubkey_str, "bio": ""},
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    agent_id, key_id, challenge = data["agent_id"], data["key_id"], data["challenge"]
    sig_b64 = base64.b64encode(
        sk.sign(base64.b64decode(challenge)).signature
    ).decode()
    resp2 = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    assert resp2.status_code == 200, resp2.text
    return agent_id, key_id, resp2.json()["agent_token"]


def _build_contact_request_envelope(
    sk: "SigningKey", key_id: str, from_id: str, to_id: str, message: str = ""
) -> dict:
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    payload = {"message": message}
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        "contact_request", "", "3600", payload_hash,
    ]
    sig_b64 = base64.b64encode(
        sk.sign("\n".join(parts).encode()).signature
    ).decode()
    return {
        "v": "a2a/0.1", "msg_id": msg_id, "ts": ts,
        "from": from_id, "to": to_id, "type": "contact_request",
        "reply_to": None, "ttl_sec": 3600,
        "payload": payload, "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }
```

- [ ] **Step 3: 在 test_app_humans.py 末尾追加新测试用例**

```python
@pytest.mark.asyncio
async def test_a2a_contact_request_approval_creates_correct_contacts(
    client, seed, db_session: AsyncSession
):
    """A2A contact_request to a claimed agent: approve → Contact rows have peer_type=agent."""
    # Bob + claimed agent (direct DB insert, mirrors existing test style)
    bob_supa = uuid.uuid4()
    bob = User(supabase_user_id=bob_supa, display_name="Bob")
    db_session.add(bob)
    await db_session.flush()
    db_session.add(
        Agent(
            agent_id="ag_claimed01234",
            display_name="Claimed",
            message_policy=MessagePolicy.contacts_only,
            user_id=bob.id,
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    # External agent registers via full A2A flow (gets hub JWT)
    sk, pub = _make_keypair()
    ext_id, ext_key, ext_token = await _register_and_verify_agent(
        client, sk, pub, "external"
    )

    # External agent sends contact_request to claimed agent via /hub/send
    env = _build_contact_request_envelope(sk, ext_key, ext_id, "ag_claimed01234", "hello")
    resp = await client.post(
        "/hub/send",
        json=env,
        headers={"Authorization": f"Bearer {ext_token}"},
    )
    assert resp.status_code in (200, 202), resp.text

    # agent_approval_queue has pending entry (not ContactRequest table)
    await db_session.expire_all()
    queue = await db_session.execute(
        select(AgentApprovalQueue).where(AgentApprovalQueue.agent_id == "ag_claimed01234")
    )
    entries = list(queue.scalars().all())
    assert len(entries) == 1, "Expected exactly one approval queue entry"
    entry = entries[0]
    assert entry.kind == ApprovalKind.contact_request
    assert entry.state == ApprovalState.pending
    assert entry.owner_user_id == bob.id

    # Bob approves via BFF endpoint
    bob_headers = {"Authorization": f"Bearer {_token(str(bob_supa))}"}
    resolve = await client.post(
        f"/api/humans/me/pending-approvals/{entry.id}/resolve",
        headers=bob_headers,
        json={"decision": "approve"},
    )
    assert resolve.status_code == 200, resolve.text
    assert resolve.json()["state"] == "approved"

    # Both Contact rows exist with peer_type=agent (not human)
    await db_session.expire_all()
    contacts = await db_session.execute(select(Contact))
    rows = {
        (c.owner_id, c.contact_agent_id, c.peer_type)
        for c in contacts.scalars().all()
    }
    assert ("ag_claimed01234", ext_id, ParticipantType.agent) in rows, \
        f"claimed→ext contact must have peer_type=agent; got rows={rows}"
    assert (ext_id, "ag_claimed01234", ParticipantType.agent) in rows, \
        f"ext→claimed contact must have peer_type=agent; got rows={rows}"
```

- [ ] **Step 4: 运行新测试，确认失败**

```bash
cd backend && uv run pytest tests/test_app/test_app_humans.py::test_a2a_contact_request_approval_creates_correct_contacts -v
```

预期：**FAILED**，断言 `peer_type=agent` 失败（实际为 `peer_type=human`）

- [ ] **Step 5: 修复 humans.py 第 538-540 行**

将：
```python
            from_type_raw = payload.get("from_type", ParticipantType.human.value)
            if from_pid:
                from_type = ParticipantType(from_type_raw) if from_type_raw in {p.value for p in ParticipantType} else ParticipantType.human
```

改为：
```python
            from_type_raw = payload.get("from_type")
            if from_pid:
                if from_type_raw and from_type_raw in {p.value for p in ParticipantType}:
                    from_type = ParticipantType(from_type_raw)
                elif from_pid.startswith("ag_"):
                    from_type = ParticipantType.agent
                elif from_pid.startswith("hu_"):
                    from_type = ParticipantType.human
                else:
                    from_type = ParticipantType.human
```

- [ ] **Step 6: 重新运行新测试，确认通过**

```bash
cd backend && uv run pytest tests/test_app/test_app_humans.py::test_a2a_contact_request_approval_creates_correct_contacts -v
```

预期：**PASSED**

- [ ] **Step 7: 运行完整 test_app_humans.py，确认无回归**

```bash
cd backend && uv run pytest tests/test_app/test_app_humans.py -v
```

预期：所有测试 **PASSED**

- [ ] **Step 8: Commit**

```bash
git add backend/app/routers/humans.py backend/tests/test_app/test_app_humans.py
git commit -m "fix(backend): infer from_type from participant_id prefix in resolve_pending_approval"
```

---

## Task 2: [F1] RoomHumanComposer placeholder 尊重 viewMode

**Files:**
- Modify: `frontend/src/components/dashboard/RoomHumanComposer.tsx:36-43`

- [ ] **Step 1: 修改 placeholder 判断条件**

将第 36-43 行（`const placeholder = activeAgent ? ...`）：

```tsx
  const placeholder = activeAgent
    ? locale === "zh"
      ? `替我的 Agent · ${activeAgent.display_name} 发言…`
      : `Speak on behalf of Agent · ${activeAgent.display_name}…`
    : locale === "zh"
      ? `作为 ${displayName} 发言…`
      : `Message as ${displayName}…`;
```

改为：

```tsx
  const placeholder = (viewMode === "agent" && activeAgent)
    ? locale === "zh"
      ? `替我的 Agent · ${activeAgent.display_name} 发言…`
      : `Speak on behalf of Agent · ${activeAgent.display_name}…`
    : locale === "zh"
      ? `作为 ${displayName} 发言…`
      : `Message as ${displayName}…`;
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

预期：无错误

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/dashboard/RoomHumanComposer.tsx
git commit -m "fix(frontend): RoomHumanComposer placeholder respects viewMode"
```

---

## Task 3: [F2] PendingApprovalsPanel i18n

**Files:**
- Modify: `frontend/src/lib/i18n/translations/dashboard.ts`（末尾追加）
- Modify: `frontend/src/components/dashboard/PendingApprovalsPanel.tsx`

- [ ] **Step 1: 在 dashboard.ts 文件末尾追加新翻译 export**

```ts
export const pendingApprovalsPanel: TranslationMap<{
  title: string
  subtitle: string
  refresh: string
  approve: string
  reject: string
  loading: string
  forAgent: string
  errorLoad: string
  errorResolve: string
}> = {
  en: {
    title: "Approvals on your agents",
    subtitle: "External requests directed at agents you own — approve or reject on their behalf.",
    refresh: "Refresh",
    approve: "Approve",
    reject: "Reject",
    loading: "Loading pending approvals…",
    forAgent: "for",
    errorLoad: "Failed to load approvals",
    errorResolve: "Failed to resolve approval",
  },
  zh: {
    title: "待审批请求",
    subtitle: "外部对你名下 Agent 发起的请求，代理审批。",
    refresh: "刷新",
    approve: "批准",
    reject: "拒绝",
    loading: "加载中…",
    forAgent: "目标 Agent：",
    errorLoad: "加载审批列表失败",
    errorResolve: "审批操作失败",
  },
}
```

- [ ] **Step 2: 更新 PendingApprovalsPanel.tsx**

在现有 import 区末尾追加两行：

```tsx
import { useLanguage } from "@/lib/i18n";
import { pendingApprovalsPanel } from "@/lib/i18n/translations/dashboard";
```

在 `export default function PendingApprovalsPanel()` 函数体第一行追加：

```tsx
  const locale = useLanguage();
  const t = pendingApprovalsPanel[locale];
```

然后替换以下硬编码字符串（全文共 8 处）：

| 原文 | 替换 |
|------|------|
| `"Loading pending approvals…"` | `{t.loading}` |
| `"Approvals on your agents"` | `{t.title}` |
| `"External requests directed at agents you own — approve or reject on their behalf."` | `{t.subtitle}` |
| `"Refresh"` | `{t.refresh}` |
| `err?.message \|\| "Failed to load approvals"` | `err?.message \|\| t.errorLoad` |
| `err?.message \|\| "Failed to resolve approval"` | `err?.message \|\| t.errorResolve` |
| `"Approve"` | `{t.approve}` |
| `"Reject"` | `{t.reject}` |
| `"for "` (span 中的 `for {entry.agent_id}`) | `{t.forAgent} ` |

- [ ] **Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

预期：无错误

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/i18n/translations/dashboard.ts frontend/src/components/dashboard/PendingApprovalsPanel.tsx
git commit -m "feat(frontend): i18n PendingApprovalsPanel zh/en"
```

---

## Task 4: [F3] ChatPane 传入 humanRooms 修复空态

**Files:**
- Modify: `frontend/src/components/dashboard/ChatPane.tsx:608-611`

- [ ] **Step 1: 确认 humanRooms 已在 selector 中（无需修改 selector）**

ChatPane.tsx 第 593-597 行已包含 `humanRooms: state.humanRooms`，无需改动。

- [ ] **Step 2: 在 buildVisibleMessageRooms 调用中补传 humanRooms**

将第 608-611 行：

```tsx
  const visibleMessageRooms = useMemo(
    () => buildVisibleMessageRooms({ overview, recentVisitedRooms, token }),
    [overview, recentVisitedRooms, token],
  );
```

改为：

```tsx
  const visibleMessageRooms = useMemo(
    () => buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms }),
    [overview, recentVisitedRooms, token, humanRooms],
  );
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

预期：无错误

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/ChatPane.tsx
git commit -m "fix(frontend): pass humanRooms to buildVisibleMessageRooms in ChatPane"
```

---

## Task 5: 最终验证

- [ ] **Step 1: 后端完整 test_app_humans 套件**

```bash
cd backend && uv run pytest tests/test_app/test_app_humans.py -v
```

预期：全部 PASSED（含新测试 `test_a2a_contact_request_approval_creates_correct_contacts`）

- [ ] **Step 2: 前端 production build**

```bash
cd frontend && pnpm build 2>&1 | tail -30
```

预期：build 成功，无 TypeScript/编译错误

- [ ] **Step 3: 查看本次所有 commit**

```bash
git log --oneline -6
```

预期：可见 4 个 fix/feat commit + 1 个 docs commit

- [ ] **Step 4: 开 PR**

```bash
gh pr create \
  --title "fix: human journey acceptance — F1/F2/F3/B1 gap fixes" \
  --body "$(cat <<'EOF'
## Summary

- **B1** `resolve_pending_approval`: infer `from_type` from `participant_id` prefix when field absent — fixes A2A-originated approvals creating wrong `peer_type=human` Contact rows
- **F1** `RoomHumanComposer`: placeholder now respects `viewMode`; switching back to Human mode restores "作为 <Name> 发言…"
- **F2** `PendingApprovalsPanel`: all UI text now goes through zh/en i18n
- **F3** `ChatPane`: `buildVisibleMessageRooms` now receives `humanRooms`; `authed-no-agent` users with human rooms no longer see RoomZeroState in main pane

## Test plan

- [ ] Backend: `uv run pytest tests/test_app/test_app_humans.py` — all PASSED incl. new A2A approval test
- [ ] Frontend: `pnpm build` — clean build
- [ ] Manual: J4 — switch AccountMenu Human→Agent→Human, verify placeholder and badge change correctly
- [ ] Manual: J5 — switch locale zh/en on contacts/requests tab, verify PendingApprovalsPanel text localises
EOF
)"
```
