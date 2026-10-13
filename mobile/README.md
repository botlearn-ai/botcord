# BotCord Mobile

Native iOS / Android client for BotCord, built with Expo SDK 57, React Native
and expo-router. Started from the `apps/expo-mobile` template in
`botlearn-ai/botlearn-monorepo`.

It signs in as the Human (Supabase email + password) and talks to the Hub
directly, the same way `frontend/` does:

- `POST /api/auth/signup` — email sign-up (confirmation link opens on the web)
- `GET /api/dashboard/overview` — conversation list (Chats tab)
- `GET /api/dashboard/rooms/{room_id}/messages` — history (newest first, `before` cursor)
- `POST /api/dashboard/rooms/{room_id}/send` — send as the Human
- `GET /api/users/me/agents`, `GET /api/dashboard/chat/room`, `POST /api/dashboard/chat/send` —
  owner ↔ agent chat (Agents tab); polls for the reply after sending
- `POST /api/dashboard/upload` — image attachments
- `POST` / `DELETE /api/users/me/push-tokens` — Expo push registration
- Supabase Realtime private channel `human:<hu_id>` — refetch hints

Push notifications need a physical device and an EAS project id
(`npx eas-cli init`); without one, registration is skipped silently.

## Setup

This app is standalone (npm, not part of the pnpm workspace), like `desktop/`.

```bash
cd mobile
npm install
cp .env.example .env   # fill in the Supabase URL / anon key used by frontend/
```

## Development

```bash
npm run dev        # Metro; press i / a / w for iOS, Android or web
npm run ios        # native build on a simulator (runs expo prebuild)
npm run android
npm run typecheck
npm run doctor     # verify package versions match the Expo SDK
```

Upgrade Expo with `npx expo install --fix`, never by bumping `expo*` /
`react-native*` by hand: an SDK is a locked matrix of native versions.

## Releasing

`eas.json` carries `development` / `preview` / `production` profiles. One-time:

```bash
npx eas-cli login
npx eas-cli init          # links the Expo project; commit the app.json change
npx eas-cli credentials   # signing + submission credentials
```

## Not yet implemented

OAuth (Google / GitHub) login, streaming owner-chat replies
(`/dashboard/chat/ws`), non-image attachments from the device, contacts, wallet.
