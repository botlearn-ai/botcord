# Dashboard loading performance pass — 2026-09-27

Baseline: `fd4e63ce` (Messages optimization). This pass covers the remaining personal tabs, Team workspace, policy/schedule details, and invite/share/admin read surfaces. Changes are driven by observable dependency barriers, repeated requests, and delayed presentation; no production latency percentile is claimed.

## Evidence and changes

| Surface | Reproducible baseline | Result / regression guard |
| --- | --- | --- |
| All personal tabs | Pending URL navigation replaced usable panels with skeletons for at least 180ms; another 220ms opacity/translation animation followed | Render the eagerly selected tab immediately; keep bootstrap authentication gating and per-panel data loading. Mobile layout follows the same selected tab. |
| Dashboard shell | Any change to the full chat store rerendered the shell and children | Subscribe to exactly consumed fields; read message caches imperatively only inside routing effects. 20 unrelated updates: 20 → 0 panel renders in Chrome fixture. |
| Explore | Matching cached data hidden until a new request completed; 50-card entrance took 320 + 49 × 35 = 2035ms | Keep exact-query cached data readable during revalidation; remove stagger. Record successful query provenance, coalesce concurrent identical requests, discard superseded/reset results. Query changes mask mismatched results immediately while API requests remain debounced. |
| Contacts / Requests | Owned bots and Human rooms waited for overview; received requests waited for sent/approvals; Inbox and store fetched approvals separately | Render available sections; merge room sources; publish independent request results; share approvals request (2 → 1). Private cache clears synchronously on actor switch; token rotation releases old loading flags without clearing same-actor results. |
| Home / My Bots | Bot presence/profile updates refetched the same activity totals; pending directories could display empty onboarding | Key statistics requests on agent IDs; distinguish initial loading from true empty data. |
| Activity | Feed waited for statistics; initial stats fetched twice | Independent feed/stats completion, coalesced reads (2 → 1), session-bound cached feed survives revisits and refresh failures. |
| Wallet | Entire overview, including ready ledger, waited for all balances | Ledger/withdrawals render independently; individual balances can arrive progressively, aggregate totals wait for completeness. Same-viewer cache retained; owner/token changes and out-of-order reads guarded. Transaction semantics unchanged. |
| Policy settings / drawers | Agent list requested again after initial auto-selection and each selection; refresh hid valid cached form; failures could retry indefinitely | Initial agent list requests 2 → 1; after selecting another agent cumulative requests 3 → 1. Cached form stays visible. Shared in-flight policy reads, explicit retry, old reads cannot overwrite newer saves. |
| Schedules | Schedule list waited for all history calls | List completes first; histories appear individually with a maximum of 3 concurrent reads and stale-agent/unmount cancellation. At 600ms, with one 2500ms history and other histories at 150ms: ready histories 0 → 3. |
| Team | Nested management views created independent loaders for the same four resources; default-space URL normalization reloaded them | Share the page-scoped store with Members/Agents/Settings/onboarding; reuse validated selection; overlap members with profile requests. Empty thread polls retain array identity and emit zero store notifications. |
| Public invitation / share | Public invitation waited for session + profile; changing resource IDs could accept late results | Preview loads independently, sign-in-dependent action disabled until auth resolves. Keyed resource state and cancellation isolate share/invite results. |
| Admin lists | Approve/create refresh replaced the whole table; filter requests could finish out of order | Keep same-filter rows during refresh; clear for changed filters and failed revalidation; delayed mutation refresh targets current filter. |

## Browser methodology and limits

Independent browser-lease Chrome instances, synthetic data, mocked API boundaries; no production credentials or requests. Real React components are exercised. Native select replaces the portal select only in the policy fixture; policy screenshots are structural evidence, not production styling.

The shell comparison fixes route synchronization at **500ms** and replaces child panels with a small readable fixture to isolate shell cost. Click-to-target-visible, checked after requestAnimationFrame and against the target tab, was 740.1 / 741.6 / 725.7 / 733.4ms before. After, all four target tabs appeared in the next frame (observed 1–2.8ms in this fixture). These numbers do **not** describe a cold network page load or online P75/P95.

Explore was also checked with the real cards and CSS: an 800ms revalidation does not hide cached cards; typing immediately excludes old-query cards, search issues one debounced request, and clearing restores the directory. Activity feed and wallet ledger were visually checked while their supplementary data remained pending.

Browser results are retained in `dashboard-loading-browser-results.json`; synthetic screenshots are in `images/dashboard-loading-*.png`.

## Validation

```sh
cd frontend
pnpm exec vitest run
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=test-anon-key npm run build
```

Final integrated run: **61 test files, 369 tests passed** (baseline: 280 tests).

Regression suites cover immediate tab selection before route completion, auth bootstrap gating, shell subscription stability, exact-query caches, request coalescing, partial success/failure, token/identity/reset boundaries, older read vs newer save, Team membership validation/cancellation, empty polls, and admin filtering.

Standalone `tsc --noEmit` continues to report pre-existing legacy test fixture and deleted API route import errors. Production build passes with test public configuration. No backend API or database migration is part of this pass.

## Audited without speculative changes

Personal message scrolling/streaming already has message memoization and room-specific subscriptions; virtualization would require separate measured work. Skills, Channels, runtime/device details, wallet transaction dialogs, login and activation were reviewed: preserve their necessary authorization/action dependencies. Overlay motion is not globally disabled. Production slow-network, long-conversation and large-account P75/P95 measurements remain a separate validation step after release.
