# Issue 206 Execution Plan

## Title

Make BotCord onboarding and scheduled runs genuinely proactive, using the existing working-memory foundation instead of inventing a new memory subsystem.

## Related Issue

- GitHub: `botlearn-ai/botcord#206`
- URL: <https://github.com/botlearn-ai/botcord/issues/206>

## Executive Summary

Issue 206 is directionally correct, but one implementation detail has already changed in the codebase:

- BotCord no longer uses a single free-text working-memory blob as the primary write model.
- The current implementation already supports:
  - account-scoped persistent memory
  - a pinned `goal`
  - named `sections`
  - section-level updates and deletes
  - automatic prompt injection at the start of BotCord sessions

This means the correct path is **not** to redesign memory storage. The correct path is to build the missing product and protocol layers on top of the current memory model:

1. onboarding should write structured working memory, not only a one-line goal
2. scheduled runs should trigger goal execution, not only inbox polling
3. BotCord skill content should be modularized into setup / proactive / scenario layers
4. user-facing setup docs should explain activation in concrete terms

## Current State

### Already Implemented

#### 1. Working memory storage model

Current shape:

```ts
type WorkingMemory = {
  version: 2;
  goal?: string;
  sections: Record<string, string>;
  updatedAt: string;
  sourceSessionKey?: string;
};
```

Meaning:

- `goal` is pinned and updated independently
- each section is independently replaceable
- memory is account-scoped and shared across sessions and rooms for the same BotCord account

#### 2. Memory write path

`botcord_update_working_memory` already supports:

- `goal`
- `section`
- `content`
- deleting a section by passing empty `content`

This is already sufficient to represent:

- `strategy`
- `weekly_tasks`
- `owner_prefs`
- `pending_tasks`
- `progress_log`
- `contacts`
- `preferences`

#### 3. Memory read path

Working memory is already injected automatically into BotCord sessions through dynamic context assembly.

#### 4. Prompt guidance

The injected memory prompt already nudges the model toward sectioned memory and names examples like `pending_tasks` and `preferences`.

### Not Yet Implemented

#### 1. Onboarding is still goal-only

Current onboarding Step 3 tells the agent to save only:

```text
botcord_update_working_memory({ goal: "<the goal>" })
```

This is not enough to drive proactive behavior.

#### 2. Scheduled task semantics are still passive

Current onboarding Step 4 suggests a cron payload like:

```text
检查 BotCord 是否有未回复的消息或待处理的任务，如果有，立即处理。
```

That behavior is inbox maintenance, not proactive goal execution.

#### 3. Skill architecture is still monolithic

`plugin/skills/botcord/SKILL.md` is still one large always-loaded skill. It has no dedicated setup/proactive/scenario decomposition.

#### 4. Skill documentation is outdated

The skill still describes working memory as a single full-replacement `content` blob, which no longer matches the current tool behavior.

## Product Goal

After installation, the user should understand one simple story:

1. open a conversation
2. tell the Bot what outcome they want
3. let the Bot save a goal plus execution strategy
4. let the Bot help configure recurring autonomous work
5. receive proactive progress or decision-needed notifications

The final behavior loop should be:

```text
goal -> strategy -> scheduled execution -> progress update -> owner feedback -> goal/plan adjustment
```

## Design Principles

### 1. Reuse the current memory model

Do not redesign storage.

Use the existing `goal + sections` model as the durable substrate.

### 2. Keep structure at the protocol layer

We do not need a strict backend schema migration for this issue.

We do need a stable protocol convention for which sections onboarding and proactive flows will use.

### 3. Separate always-on rules from conditional instructions

Daily message handling, first-time setup, scheduled execution, and scenario playbooks should not all compete in one giant skill prompt.

### 4. Optimize for user understanding, not internal purity

User-facing docs and prompts should explain:

- what to say
- what the Bot will do next
- what result to expect

They should not foreground internal concepts.

## Proposed Working Memory Contract

This issue should standardize on the following section conventions.

### Required fields

- `goal`
  - one-sentence durable objective

### Recommended sections

- `strategy`
  - short explanation of the Bot's proactive operating strategy
- `weekly_tasks`
  - bullet list of concrete tasks for the next 7 days
- `owner_prefs`
  - approval boundaries and operating preferences
- `pending_tasks`
  - user-tracked items that should influence relevance and notification behavior
- `progress_log`
  - concise record of durable progress, not full activity history

### Example

```text
goal: 帮 owner 在 BotCord 上接单做 PPT 和数据分析

section: strategy
content:
- 主动在公开空间展示能力
- 优先响应潜在客户的 DM 和询价
- 对进行中的交付保持短周期跟进

section: weekly_tasks
content:
- 更新资料页中的作品案例
- 浏览并接触 3 个潜在客户
- 跟进所有未结束报价

section: owner_prefs
content:
- 转账超过 1000 COIN 前必须确认
- 接受联系人请求必须确认
- 新建或加入房间必须确认

section: pending_tasks
content:
- 年终总结 PPT 项目
- 数据分析演示稿修改
```

## Scope

### In Scope

- setup-instruction documents
- onboarding hook prompt redesign
- skill modularization for setup / proactive / scenarios
- proactive cron message semantics
- memory protocol guidance updates
- front-end prompt/template text alignment where already applicable

### Out of Scope

- backend schema changes
- a formal typed memory schema persisted by the backend
- new cron engine features
- a new vector-memory or embedding system
- front-end “scenario launcher” UI as a hard dependency

## Implementation Plan

## Phase 0: Source-of-Truth Alignment

### Goal

Remove contradictions between current implementation and documentation before changing behavior.

### Changes

1. Update `plugin/skills/botcord/SKILL.md`
   - rewrite the working-memory section to match the current tool API
   - describe `goal`, `section`, `content`
   - remove stale “full replacement only” language

2. Add a short “Quick Entry” section near the top of `SKILL.md`
   - first-time setup -> see `SKILL_SETUP.md`
   - scheduled autonomous task -> see `SKILL_PROACTIVE.md`
   - scenario-specific setup -> see `SKILL_SCENARIOS.md`

### Files

- `plugin/skills/botcord/SKILL.md`

### Acceptance Criteria

- no stale documentation remains for the old single-content memory semantics
- the always-loaded skill points to the new child files clearly and briefly

## Phase 1: Skill Modularization

### Goal

Keep the always-loaded skill lean, and move setup/proactive/scenario protocols into dedicated files.

### Changes

1. Create `plugin/skills/botcord/SKILL_SETUP.md`
   - used when no meaningful `goal` exists or when the user asks to set up / activate / start
   - contains:
     - scenario introduction
     - structured memory confirmation flow
     - cron setup guidance
     - activation completion signal

2. Create `plugin/skills/botcord/SKILL_PROACTIVE.md`
   - used when scheduled runs carry the proactive trigger message
   - contains:
     - execution order
     - inbox handling first
     - strategy-driven action second
     - progress update discipline
     - owner notification thresholds
     - permission boundaries

3. Create `plugin/skills/botcord/SKILL_SCENARIOS.md`
   - maps common scenarios to concrete operational playbooks
   - should cover at minimum:
     - AI freelancer / agent service room
     - knowledge subscription
     - team async collaboration
     - social networking
     - customer service
     - monitoring / alerts

### Files

- `plugin/skills/botcord/SKILL.md`
- `plugin/skills/botcord/SKILL_SETUP.md`
- `plugin/skills/botcord/SKILL_PROACTIVE.md`
- `plugin/skills/botcord/SKILL_SCENARIOS.md`

### Acceptance Criteria

- `SKILL.md` remains focused on daily BotCord behavior and tool reference
- setup/proactive/scenario instructions are split out and readable in isolation
- the setup and proactive protocols do not bloat the always-loaded skill

## Phase 2: Onboarding Redesign

### Goal

Turn onboarding from “set one goal and check messages” into “define a goal, define a strategy, and activate autonomous execution”.

### Changes

1. Redesign onboarding Step 3 in `plugin/src/onboarding-hook.ts`
   - based on the selected scenario, generate a structured working-memory draft
   - require user confirmation before writing
   - write at least:
     - `goal`
     - `strategy`
     - `weekly_tasks`
     - `owner_prefs`

2. Improve onboarding Step 2
   - keep scenario selection
   - add “what happens next” hints so the model knows whether to:
     - create a room
     - configure a service flow
     - only store strategy and monitoring logic

3. Redesign onboarding Step 4
   - cron message changes from passive checking to proactive execution
   - recommended payload:

```text
【BotCord 自主任务】执行本轮工作目标。
```

4. Add activation language
   - the Bot should explicitly tell the user:
     - their Bot is now activated
     - it will work toward the goal on schedule
     - important progress or decisions will be reported proactively

### Files

- `plugin/src/onboarding-hook.ts`
- `plugin/src/__tests__/memory-hook.test.ts`
- new or updated onboarding tests

### Acceptance Criteria

- onboarding no longer writes only a goal
- onboarding produces a structured plan in memory
- cron setup language clearly frames proactive work
- the user is given a concrete completion signal

## Phase 3: Proactive Execution Protocol

### Goal

Give scheduled runs a stable operating procedure so the Bot does useful work instead of only polling.

### Protocol

When a scheduled message contains the proactive trigger:

1. process the inbox first
   - reply only where a reply is warranted
   - never auto-accept contact requests
   - surface urgent items or approval-needed items

2. inspect working memory
   - read `goal`
   - read `strategy`
   - read `weekly_tasks`
   - read `owner_prefs`
   - read `pending_tasks` when relevant

3. take one or more concrete goal-advancing actions
   - examples:
     - follow up on an in-progress customer thread
     - create or update a relevant room
     - publish a content item
     - send a targeted outreach message
     - scan rooms and notify on relevant events

4. update memory only if something durable changed
   - progress milestone
   - new durable pending task
   - changed owner preference
   - material plan update

5. notify the owner only when appropriate
   - decision needed
   - meaningful progress
   - blockage
   - opportunity needing fast approval

### Changes

1. encode this protocol in `SKILL_PROACTIVE.md`
2. ensure the scheduled message string reliably activates this mode
3. add tests or fixtures where current test shape allows it

### Files

- `plugin/skills/botcord/SKILL_PROACTIVE.md`
- `plugin/src/onboarding-hook.ts`
- possibly `plugin/src/dynamic-context.ts` if trigger-specific context needs to be surfaced

### Acceptance Criteria

- scheduled turns are framed as goal execution, not inbox-only maintenance
- owner notifications follow explicit criteria
- the Bot is guided to write durable progress back into memory selectively

## Phase 4: Scenario Playbooks

### Goal

Make setup actionable for the common “what do I want this Bot to do?” paths.

### Changes

Build scenario mappings in `SKILL_SCENARIOS.md` that align with existing front-end prompt templates:

1. AI freelancer
   - map to agent service room creation flow
   - add pricing / quoting guidance
   - write service strategy into memory

2. Content creator / subscription
   - map to knowledge subscription or skill-share room flow
   - define content cadence and monetization strategy

3. Team coordinator
   - map to team async room flow
   - use `pending_tasks` guidance for relevance and notification logic

4. Social networker
   - no mandatory room creation
   - define networking strategy, outreach boundaries, and follow-up style

5. Customer service
   - define FAQ / escalation / notification policy

6. Monitoring / alerts
   - define signal sources, keyword or event focus, and urgency thresholds

### Files

- `plugin/skills/botcord/SKILL_SCENARIOS.md`

### Acceptance Criteria

- each supported scenario results in a concrete next action path
- onboarding can use the scenario file as an operational reference instead of a generic description

## Phase 5: Setup Docs and Best Practices Refresh

### Goal

Make the external docs explain activation and expected behavior in concrete user terms.

### Changes

1. Update setup-instruction files
   - add a new activation step after installation / restart
   - explain:
     - open a conversation
     - tell the Bot the job
     - the Bot will set a goal and strategy
     - the Bot will help configure recurring autonomous work
     - after setup it will report important progress proactively

2. Update the Step 4 ending text in setup docs
   - replace vague “the plugin will guide you” wording
   - state what the first conversation will do

3. Update onboarding and best-practices templates
   - reflect the new proactive cron intent
   - explain the quick-start path
   - preserve consistency with the current memory tool semantics

### Files

- `openclaw-setup_instruction.md`
- `openclaw-setup-instruction-beta.md`
- `frontend/src/lib/templates/setup-instruction.template.md`
- `frontend/src/lib/templates/setup-instruction-script.template.md`
- `frontend/src/lib/templates/setup-instruction-beta.template.md`
- `frontend/src/lib/templates/setup-instruction-script-beta.template.md`
- `openclaw-best-practices.md`
- `frontend/src/lib/templates/best-practices.template.md`
- `frontend/src/lib/templates/onboarding.template.md`

### Acceptance Criteria

- installation docs clearly state what the user should do after restart
- best-practices has a quick-start path, not only a rule dump
- setup docs and onboarding docs describe the same proactive model

## Recommended Memory Section Templates By Scenario

### AI Freelancer

- `goal`
- `strategy`
- `weekly_tasks`
- `owner_prefs`
- optional `pricing_rules`

### Content Creator

- `goal`
- `strategy`
- `weekly_tasks`
- `owner_prefs`
- optional `content_focus`

### Team Coordinator

- `goal`
- `strategy`
- `weekly_tasks`
- `owner_prefs`
- `pending_tasks`

### Monitoring / Alerts

- `goal`
- `strategy`
- `weekly_tasks`
- `owner_prefs`
- optional `alert_rules`

## Testing Plan

### Plugin Tests

1. onboarding prompt tests
   - verifies structured memory guidance appears
   - verifies proactive cron message appears

2. working-memory tool tests
   - already cover section updates
   - add focused tests for recommended setup sections if needed

3. dynamic-context tests
   - verify sectioned memory remains injected correctly

4. skill smoke review
   - manually verify all new skill files are coherent and referenced correctly

### Front-End Validation

1. `frontend` build passes
2. template text is consistent across:
   - onboarding template
   - setup-instruction templates
   - best-practices template

### Manual End-to-End Checks

1. fresh user install
2. first conversation:
   - select scenario
   - confirm structured memory
   - create cron
3. scheduled trigger:
   - receives proactive trigger message
   - performs inbox handling
   - performs one goal-directed action
   - notifies owner only when criteria are met

## Rollout Order

Recommended PR order:

1. PR 1: doc and skill alignment
   - update `SKILL.md`
   - add child skill files
   - no major runtime behavior change yet

2. PR 2: onboarding hook redesign
   - structured memory setup
   - proactive cron message
   - tests

3. PR 3: setup docs and best-practices refresh
   - update public docs and front-end templates

4. PR 4: polish and follow-up
   - refine scenario mappings
   - adjust notification thresholds from usage feedback

## Risks

### 1. Overloading working memory

Risk:
- onboarding writes too much text and degrades prompt efficiency

Mitigation:
- keep each section concise
- treat `weekly_tasks` and `progress_log` as short bullet lists
- keep the total memory budget discipline already enforced by the tool

### 2. Skill fragmentation without real load control

Risk:
- adding child markdown files does not reduce context unless the main skill uses them intentionally

Mitigation:
- keep `SKILL.md` minimal
- explicitly direct the agent to consult the relevant child file only when the trigger condition applies

### 3. “Proactive” becomes spammy

Risk:
- scheduled runs may notify too often or perform low-value actions

Mitigation:
- define notification thresholds in `SKILL_PROACTIVE.md`
- keep owner approval boundaries explicit in `owner_prefs`

### 4. Documentation drift

Risk:
- templates, onboarding hook, and skill docs diverge again

Mitigation:
- treat this plan as the source of truth
- keep one terminology pass as part of each related PR

## Definition of Done

Issue 206 should be considered done when all of the following are true:

1. first-time setup writes structured working memory, not only a single goal
2. scheduled tasks trigger proactive goal execution semantics
3. BotCord skill documentation is split into setup / proactive / scenarios support files
4. `SKILL.md` correctly documents the current memory tool semantics
5. setup and best-practices docs explain activation and proactive behavior concretely
6. plugin tests and front-end build validations pass

## Recommended Comment Summary For The Issue

Short version:

- memory storage does not need redesign
- current `goal + sections` working memory is sufficient
- the real work is onboarding, cron semantics, skill modularization, and doc alignment
- implementation should proceed in four PR-sized phases:
  - skill/doc alignment
  - onboarding redesign
  - public/setup doc refresh
  - scenario polish
