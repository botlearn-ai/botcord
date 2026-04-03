# Working Memory Tool Refactor

## Summary

This change replaces the previous XML-in-output memory update protocol with an explicit tool call:

- Old: the agent embedded `<memory_update>...</memory_update>` inside generated output, and BotCord intercepted the text, stripped the XML block, and persisted the content.
- New: the agent calls `botcord_update_working_memory` to persist working memory explicitly.

The read path is unchanged:

- BotCord still injects current working memory into the prompt through `before_prompt_build`.
- Working memory remains a single persisted text blob with complete-replacement semantics.

## Why Change It

The XML-based mechanism worked, but it mixed two separate concerns into one channel:

- visible reply generation
- persistent state mutation

That had several drawbacks:

- Reply text and side effects were coupled.
- The system needed output interception and tag sanitization logic.
- The protocol was less observable than a normal tool call.
- Future extension would become awkward as memory operations grow.

Using a tool call makes the side effect explicit and keeps final user-visible output separate from state changes.

## Goals

- Keep working memory prompt injection exactly as a read-only context source.
- Replace output parsing with an explicit write tool.
- Preserve current storage model and complete-replacement semantics.
- Make it clearer when the agent should and should not update memory.

## Non-Goals

- No structured memory schema in this refactor.
- No partial patch / merge / delete operations.
- No room-state redesign.
- No cross-instance synchronization changes.

## Current Definition of Working Memory

Working memory is global, persistent, cross-session context. It is appropriate for:

- important long-lived facts
- pending commitments and follow-up obligations
- stable user or agent preferences
- durable person profiles
- durable person-to-person or person-to-room relationships
- other key context likely to matter in future turns

It is not appropriate for:

- one-off chatter
- transient emotions or momentary impressions
- verbose summaries of the current turn
- room-local operational state that belongs in room state
- details that are useful only for the current reply

## Design

### Read Path

No change.

- `before_prompt_build` continues to inject the working memory block.
- The prompt now tells the model to call `botcord_update_working_memory` instead of embedding XML.

### Write Path

Add a new tool:

- `botcord_update_working_memory`

Parameters:

- `content: string`

Semantics:

- `content` is the complete replacement working memory.
- The tool trims surrounding whitespace and writes `working-memory.json`.
- The tool should only be called when something meaningful and durable changes.

### Removed Behavior

The following behavior is intentionally removed:

- parsing `<memory_update>` out of generated replies
- stripping XML control blocks from outgoing visible text
- updating memory from suppressed A2A narration output

## Tool Semantics

Tool name:

- `botcord_update_working_memory`

Behavior:

- explicit side effect
- complete replacement, not append
- no-op avoidance is prompt-driven, not enforced by backend logic

Return shape:

- `ok`
- `updated`
- `content_length`

## Prompt And Tool Guidance

The runtime prompt and tool description should both reinforce the same rule set.

The agent should update working memory when:

- a new long-lived fact becomes relevant
- a stable preference is learned
- a durable person/profile insight is established
- a relationship or responsibility mapping becomes important
- a pending commitment or follow-up obligation is created or changes
- existing working memory becomes materially outdated

The agent should not update working memory when:

- the information is only useful for the current turn
- the content is room-specific operational state
- the content is casual filler or social small talk
- the content is a speculative or weakly supported personality judgment
- the content is just a verbose recap of what was already said

## Tradeoffs

### Advantages

- Cleaner separation between final reply and state mutation
- Better observability through normal tool-call logs
- Less fragile than text interception
- Better foundation for future structured memory operations

### Costs

- The agent must decide to call the tool explicitly
- Tool guidance quality becomes more important
- `sourceSessionKey` is no longer captured by the write path in this minimal refactor

## Files Affected

- `plugin/src/memory-protocol.ts`
- `plugin/src/tools/working-memory.ts`
- `plugin/index.ts`
- `plugin/src/inbound.ts`
- `plugin/src/memory-hook.ts`
- related tests under `plugin/src/__tests__/`

## Validation

Targeted validation for this refactor:

- prompt builder tests
- memory hook tests
- new working-memory tool tests
- hook registration smoke test
- TypeScript check

## Rollout Notes

This is intentionally a small refactor. It changes only the update mechanism, not the underlying memory model.

If future work is needed, the next reasonable step would be to decide whether working memory should remain a single free-text blob or evolve into structured sections such as:

- commitments
- people profiles
- relationships
- preferences

That is out of scope for this change.
