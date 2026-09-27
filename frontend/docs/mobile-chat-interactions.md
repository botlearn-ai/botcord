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
