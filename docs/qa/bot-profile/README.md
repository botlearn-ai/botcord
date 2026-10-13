# Bot Profile UI verification

Chromium touch simulation at 320, 375 and 430px, in light and dark themes.
A temporary local route mounted the real BotDetailDrawer with in-memory agent data and a mocked save API. The route was removed after verification.

Verified default read mode, visible ID copy control and clipboard contents, explicit edit/add bio, cancel, save and header synchronization, long name/bio, no horizontal overflow and drawer close.

Screenshots: [375px light display](mobile-view.png), [320px dark editor](mobile-edit.png).
The fixture has no capability rating or linked device; its rating error is fixture data, not a production API result.

This is browser emulation, not an iPhone keyboard/safe-area test or production authorization test.
