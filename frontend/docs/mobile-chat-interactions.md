# Mobile chat interaction fixes

The message view now has an explicit return-to-list state transition. On phones,
both the header back button and the Messages tab clear the open conversation,
request panel and mobile overlay together, while protecting the transition from
an old URL that is still resolving. Bot-chat loading and error states retain a
back action as well.

The mobile rail contains four primary destinations and More. Discover, Wallet,
theme, language and account actions live in More. The header and rail cannot
shrink into adjacent content, and the initial loading shell uses the same mobile
layout. Message scrolling targets only the message container.

Touch users can see message actions and attachment removal without hovering.
Primary composer controls have 44px targets. Touch Return inserts a newline;
desktop Enter still sends and Shift+Enter inserts a newline. IME composition is
preserved. Mention selection and message actions use click activation so touch
and keyboard activation work. Composer menus render outside clipping ancestors
and are constrained to the visual viewport. The app tracks viewport changes and
hides global navigation while a software keyboard occupies the bottom area.

## Verification (2026-09-27)

- `npm run test -- --run` in `frontend`: 62 files, 376 tests passed.
- Production build passed with `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co`
  and `NEXT_PUBLIC_SUPABASE_ANON_KEY=local-build-placeholder`. These are build-only
  placeholders; no production account or service was used.
- Browser checks used real Sidebar, ChatPane, RoomHeader, MessageList,
  MessageBubble, RoomHumanComposer and AccountMenu components with synthetic
  local session/message data and stubbed network actions.
- Viewports: 320, 390 and 430 CSS pixels with touch enabled; 1280px desktop.
- Verified header visibility after long-message scrolling, both mobile return
  paths, More destinations, theme/language switching, keyboard activation of
  message actions, touch mention selection, newline behavior, send callback,
  attachment removal, and composer action menus.
- Simulated a 420px visual viewport while editing: navigation hides, the composer
  and mention candidates remain visible, and navigation returns after restoration.
- No browser page errors in these checks. Layout measurements are in
  [mobile-chat-browser-results.json](mobile-chat-browser-results.json).

This is component-level browser verification with synthetic data, not a logged-in
production end-to-end test. Native iOS keyboard animations, safe-area behavior in
installed PWAs and the actual network send/upload path still need device testing.

## Screenshots

- [390px conversation](screenshots/mobile-chat/chat-390.png)
- [390px message list after returning](screenshots/mobile-chat/list-390.png)
- [320px More menu](screenshots/mobile-chat/more-320.png)

## Focused conversation follow-up

On phones, room and Bot conversations now hide both the bottom navigation and
Personal / Team switch until the user returns to the message list. Requests and
other modules retain navigation. The sidebar stays mounted and restores its last
visible scroll offset; the deep-link loading shell also hides global navigation.
The composer retains bottom safe-area spacing when the keyboard is closed.

Validation: 382 tests passed. Browser checks at 320/390/430px confirmed hidden
navigation in details and restored navigation and a 450px message-list scroll
offset after returning. The 1280px desktop retained both navigation areas.

- [Focused conversation](screenshots/mobile-chat/focused-detail-390.png)
- [Restored message list](screenshots/mobile-chat/restored-list-390.png)

## Composer research and follow-up (2026-09-28)

Sources and decisions:

- [Chrome viewport/keyboard behavior](https://developer.chrome.com/blog/viewport-resize-behavior):
  a keyboard may resize only the visual viewport; fixed layout and viewport units
  alone do not guarantee a visible composer. Retain the existing VisualViewport
  resize/scroll tracking, portaled menus, and keyboard-aware safe-area spacing.
- [W3C target size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html):
  retain 44px primary controls and candidate rows, including the new @ shortcut.
- [W3C autocomplete keyboard guidance](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/):
  retain input focus while navigating suggestions; expose the list and active
  option using aria-controls/aria-activedescendant. The editor remains a native
  multiline textarea, with list autocomplete only when candidates are available.

Changes: a visible @ shortcut inserts at the caret or replaces a selection;
existing queries are reused. Chinese punctuation boundaries and full-width ＠
can trigger suggestions. Escape stays closed after keyup. IME composition owns
all its keys, including arrows, Enter and Escape. Candidate IDs truncate on
narrow screens. Sending refocuses the editor synchronously, and mouse presses on
send do not first blur it. Mobile font size is explicitly 16px; touch Return
continues to insert a newline outside suggestion selection.

Browser runtime discovery returned no available browser for this follow-up;
no new screenshots or native-keyboard claims are made. Real iOS Safari and
Android keyboard opening/closing, candidate swipe scrolling, long drafts, and
320/390/430px visual layout still need device/browser verification. Earlier
screenshots above describe the earlier implementation, not these changes.

Validation for this follow-up: 5 focused test files / 37 tests passed, including
DOM interaction coverage for shortcut → candidate → send with the correct member
ID, input focus after send, Escape/keyup dismissal, and IME arrow/Enter/Escape
isolation. The production build passed with the same build-only Supabase
placeholders documented above. jsdom is a development-only test dependency;
these interaction tests do not emulate native soft keyboards or layout.

## Android emulator verification (2026-09-28)

User-requested follow-up used the installed `booking_chat_api35` AVD: Pixel 7,
Android 15 / API 35, 1080×2400 at 420 dpi, Chrome 124.0.6367.219, and Gboard.
ADB taps, swipes, native Return-key taps and screenshots exercised a local,
production-bundled fixture loading the actual MessageComposer, ComposerPopover,
useChatViewport and application CSS. The shell and members were synthetic;
send callbacks were recorded locally without contacting the Hub.

Found and fixed a real positioning race: keyboard resizing changes the chat root
in requestAnimationFrame, moving the composer without resizing it. The popup
previously measured too early and overlapped the editor. Observe the anchor's
layout ancestors as well, and schedule viewport/scroll measurements in the next
animation frame so scrolling cannot leave stale coordinates either.

Verified keyboard opening, the @ shortcut, member selection, multiline Return
without sending, sending a member ID, retaining the keyboard after send, and
swiping the candidate list to select a later member. Local callbacks contained
`mentions: ["hu_alice"]` with a newline-bearing message and then
`text: "@Bot 5 ", mentions: ["ag_bot_5"]` after scrolling.

Evidence:
- [Original overlap](screenshots/android-composer/before-overlap.png)
- [Fixed candidate list and native keyboard](screenshots/android-composer/mentions-keyboard.png)
- [Scrolled candidates remain above the composer](screenshots/android-composer/scrolled-candidates.png)

Regression coverage now includes ancestor resize and deferred scroll positioning:
6 focused files / 38 tests passed. Production build passed with build-only
Supabase placeholders. This is Android emulator component verification, not an
online authenticated end-to-end test; Chinese IME composition and iOS keyboard
behavior have not been exercised on a device in this follow-up.

Keyboard dismissal was also verified: the keyboard reports hidden, the composer
returns to the bottom, the draft clears, and the selected member ID appears in
the local send result. [Sent message and restored layout](screenshots/android-composer/sent-keyboard-closed.png).

## Mention presentation alignment (2026-09-28)

Room/group messages, ordinary DMs, owner-chat optimistic/failed/delivered
messages, typewriter output and streaming assistant text now share ChatMarkdown
and MentionChip. Human and agent names retain the existing cyan underline and
profile actions; room references use the existing `/chats/messages/{roomId}`
route. IDs remain in serialized messages but are hidden in rendered mentions.
Known plain-name mentions also recognize Chinese punctuation without producing
duplicate metadata chips. Markdown code and links retain their existing behavior.

The shared native textarea now highlights selected mentions through a visual
layer, while the editable value contains friendly names. Selected ranges retain
exact IDs, including different people with the same name. Edits reconcile these
ranges; changing a selected name removes its identity. Native beforeinput ranges
resolve ambiguous edits between identical names. Forwarded structured text is
hydrated to the same draft representation and round-trips to the wire format.
Caret placement happens synchronously when selecting a candidate, avoiding races
with immediately following input. Group-only @all, DM member scope, and the
broader owner-chat contact/room picker remain unchanged.

Android verification used the same AVD and keyboard as above, now rendering sent
messages with the actual MessageBubble rather than the earlier simplified message
list. It confirmed a highlighted `@Alice` draft followed by the regular clickable
mention in the message bubble. The local callback recorded
`text: "@Alice(hu_alice) hello", mentions: ["hu_alice"]`.

- [Highlighted native textarea](screenshots/android-composer/highlighted-draft.png)
- [Actual message bubble with highlighted mention](screenshots/android-composer/highlighted-message.png)

Validation: all 74 frontend test files / 492 tests passed, and the production
build passed with the build-only Supabase placeholders. Tests cover shared
rendering, human/bot click actions, room links, Chinese punctuation, group/DM
candidate scope, editing/removing/serializing selected mentions, same-name
identity preservation, forwarded drafts and immediate typing after selection.
A standalone `tsc --noEmit` also reports errors in untouched legacy API test
imports and test fixtures; it is not a clean check for this repository. The
production build's TypeScript check passed. Android evidence remains a local
component test, not authenticated group/DM/owner-chat network verification; iOS
and native Chinese IME composition still need device coverage.

### Existing group reply indicator alignment (2026-09-28)

Mobile and desktop use the same MessageBubble replying avatar stack in the
message footer: pulsing agent avatar(s), a name for one responder, up to three
avatars plus an overflow count for multiple responders. The existing runtime
status-reaction lifecycle and trigger conditions are unchanged. The indicator
now has a localized accessible status label; each actor's expiry is scheduled
independently so a later actor cannot remain stuck after the first expires.
The separate phase-row redesign and direct-chat runtime expansion were removed
to preserve the existing normal-mode interaction. Owner-chat typing and stream
presentation, and delivery badge settings, retain their original behavior.

Validation after restoring the normal interaction: all 75 frontend test files /
493 tests passed; production build passed. The reply-indicator regression test
covers avatar overflow, sequential actor expiry and cleared reactions. Footer
items can wrap on narrow screens. Android evidence uses the actual shared
MessageBubble with synthetic reactions, not an authenticated runtime session.

[Android normal-mode avatar reply indicator](screenshots/android-composer/normal-reply.png)

### Chat avatars (2026-09-28)

Mobile message headers now use actual participant avatars instead of tiny
Human/Bot category icons. Desktop keeps its outside-bubble avatar; full-width
messages retain an inline avatar. The shared ParticipantAvatar uses a human's
profile image, falling back to the first Unicode character of their display
name when absent or unavailable. Bot avatars use the existing deterministic
pool. Owner-chat final, optimistic, failed and runtime-error messages use the
same component and session profile sources.

Avatar and reply-indicator focused tests passed, including broken image fallback,
changed image URL recovery, human profile rendering in the mobile header, and
bot fallback selection. Production build passed.
Android local-component screenshot: [Human avatar fallback](screenshots/android-composer/avatars.png).
