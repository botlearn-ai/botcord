---
"@botcord/daemon": patch
---

fix(daemon): show group "replying" status reaction for CJK action mentions

The group-room replying status reaction (⏳) was gated behind an English-only
keyword regex (`ACTION_MENTION_RE` / `STRONG_ACTION_MENTION_RE` / `FYI_MENTION_RE`)
plus `?`/`？`. zh-only team rooms whose messages carry no Latin token (e.g.
"什么结论了", "帮忙改一下") never matched, so the reaction silently stopped
appearing after the 6-13 mention-handling hardening. Extend the gates to cover
CJK action verbs, question markers, and no-action/FYI phrases, with a negation/
done-state lookbehind so "不用处理"/"已经修复" stay suppressed.
