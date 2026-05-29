---
"@botcord/daemon": patch
---

fix(daemon): refresh stale JWT on 401 for typing/stream-block control requests

`typing()` and `streamBlock()` in the BotCord channel called `ensureToken()` +
raw `fetch()`, bypassing `hubFetch`'s 401→refresh retry. When a token was
invalidated (e.g. a Hub JWT secret rotation) but not yet expired, `ensureToken()`
kept returning the stale token, so presence/streaming pings 401'd in a loop until
the next actual message send happened to refresh it — the conversation showed no
typing indicator or live stream. Both now route through a shared
`postControlWithRefresh` helper that refreshes the token once and retries on 401.
