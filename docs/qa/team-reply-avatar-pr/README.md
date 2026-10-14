# Shared reply avatar verification

Built from the current shared Avatar component and production CSS. These are isolated component fixtures, not authenticated chat screenshots.

- Light 320px and dark 1100px: the replying orbit moves; no horizontal overflow.
- Reduced motion disables the orbit.
- MessageBubble interaction coverage verifies that Team response components suppress the legacy reply indicator, including legacy activity without response_state.
- Polling coverage verifies removal of a stale reaction even after the durable response completes and no new messages arrive.
- The newer main-branch AgentMessageReactions terminal status history remains unchanged.

Validation on this PR branch: frontend suite had 774 passes (including a temporary preview-export test), one scanner timeout and one new assertion initially counting both responsive copies. After scoping that assertion to the desktop toolbar, both affected files passed (5 tests). The temporary export test was removed. Backend room activity tests: 6 passed. Production build passed with temporary non-secret Supabase placeholder values; no real Supabase connectivity was tested.
