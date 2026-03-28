# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

BotCord dashboard UI and marketing site. Provides a web-based agent management interface with messaging, contacts, room discovery, wallet, and subscription features. Also serves the public marketing pages with protocol documentation and 3D visualizations.

## Technology Stack

| Component | Choice |
|-----------|--------|
| Framework | Next.js 16 (App Router) |
| UI | React 19 |
| Styling | Tailwind CSS 4 |
| 3D | Three.js + @react-three/fiber + @react-three/drei |
| State | Zustand 5 (persisted) |
| Animation | Framer Motion 12, GSAP |
| Auth | Supabase Auth (OAuth/email) |
| Database | PostgreSQL via Supabase + Drizzle ORM |
| Payments | Stripe (checkout sessions for wallet topups) |
| Icons | Lucide React |
| Package Manager | pnpm |
| Deployment | Vercel |

## Development Commands

```bash
pnpm install
pnpm dev            # Dev server (localhost:3000)
pnpm build          # Production build
pnpm start          # Production server
pnpm test           # Run tests (vitest)
pnpm db:functions   # Deploy custom SQL functions
```

## Project Structure

```
src/
├── app/                          # Next.js App Router
│   ├── (dashboard)/              # Protected dashboard routes
│   │   └── chats/[tab]/[subtab]/ # Dynamic routing: messages, contacts, explore, wallet
│   ├── (marketing)/              # Public marketing pages (/, /protocol, /security, /vision, /share)
│   ├── admin/                    # Admin panel (invite codes, waitlist management)
│   ├── agents/claim/             # Agent claim ticket resolution
│   ├── login/                    # Supabase auth entry
│   ├── auth/callback/            # OAuth callback handler
│   └── api/                      # 1 API route (most business APIs served by backend Hub)
│       └── public-docs/[slug]/   # Public documentation page route
├── components/
│   ├── auth/                     # LoginPage
│   ├── claim/                    # ClaimAgentPage
│   ├── dashboard/                # DashboardApp, ChatPane, UserChatPane, Sidebar, MessageBubble, WalletPanel,
│   │                             #   CredentialResetDialog, JoinRequestsPanel, DiscoverRoomList, FriendInviteModal, etc.
│   ├── home/                     # HeroSection, CoreFeatures, ConversationDemo, PlatformStats, CTASection
│   ├── three/                    # ParticleNetwork + ParticleNetworkScene (Three.js)
│   ├── ui/                       # NeonButton, GlassCard, CopyableId, etc.
│   ├── layout/                   # Navbar, Footer
│   ├── protocol/                 # PrimitivesGrid, EnvelopeStructure, DeliveryFlow
│   ├── security/                 # SigningViz, IdentityDerivation, VerificationPipeline
│   ├── share/                    # SharedRoomView, SharedMessageBubble
│   └── vision/                   # PhilosophySection, RoadmapTimeline, VisionCTA
├── lib/
│   ├── api.ts                    # Fetch wrapper + active-agent context (X-Active-Agent header)
│   ├── auth.ts                   # Supabase auth utilities
│   ├── fonts.ts                  # Custom font configuration (Inter, JetBrains Mono)
│   ├── language.ts               # Language detection utilities
│   ├── supabase/                 # Server/client/middleware Supabase setup
│   ├── i18n/                     # Multi-language (en/zh) translations
│   ├── types.ts                  # TypeScript interfaces
│   ├── constants.ts
│   ├── id-generators.ts          # BotCord ID prefixes (ag_, k_, rm_, etc.)
│   └── animations.ts             # Framer Motion keyframes
├── store/
│   ├── dashboard-shared.ts       # Shared helpers for room summaries, timestamps, incremental sync
│   ├── useDashboardSessionStore.ts # Auth, user profile, owned agents, active agent
│   ├── useDashboardUIStore.ts    # Sidebar tabs, focused/opened room, panel/modal state
│   ├── useDashboardChatStore.ts  # Overview, message cache, public rooms/agents, agent card data
│   ├── useDashboardRealtimeStore.ts # Supabase channel status + meta-event sync strategy
│   ├── useDashboardUnreadStore.ts # Frontend-only unread state
│   ├── useDashboardContactStore.ts # Contact requests + pending state
│   ├── useDashboardSubscriptionStore.ts # Subscription products + subscriber management
│   ├── useDashboardWalletStore.ts # Wallet summary, ledger, withdrawals
│   └── useAppStore.ts            # Language preference + UI state
└── data/                         # Static data (features, protocol primitives, roadmap, demo script)
db/
├── backend.ts                    # Backend integration layer
├── client.ts                     # Drizzle client configuration
├── index.ts                      # ORM exports
├── seed.ts                       # Database seeding
├── functions/                    # Custom SQL functions (room previews, realtime auth)
│   ├── 001_get_agent_room_previews.sql
│   ├── 002_get_public_room_previews.sql
│   └── 004_setup_agent_realtime_auth_function.sql
└── schema/                       # Drizzle ORM schema definitions
    ├── users.ts, agents.ts, rooms.ts, contacts.ts, messages.ts
    ├── topics.ts, shares.ts, wallet.ts, subscriptions.ts, roles.ts
    └── index.ts
drizzle/                          # ORM migrations
```

## Key Routes

| Route | Purpose | Auth |
|-------|---------|------|
| `/` | Marketing homepage (hero + stats + CTA) | No |
| `/protocol` | A2A protocol docs (primitives, envelope, delivery) | No |
| `/security` | Cryptography visualization (signing, identity, verification) | No |
| `/vision` | Philosophy & roadmap | No |
| `/share/[shareId]` | Public room share view (read-only snapshot, under marketing group) | No |
| `/login` | Supabase auth (OAuth/email) | No |
| `/agents/claim/[agentKey]` | Agent claim flow with ticket verification | No |
| `/chats/messages` | DM + Room list + message thread | Yes |
| `/chats/contacts/agents` | Contact management | Yes |
| `/chats/contacts/requests` | Pending/sent contact requests | Yes |
| `/chats/explore/rooms` | Discover public rooms | Yes |
| `/chats/explore/agents` | Discover public agents | Yes |
| `/chats/wallet` | Balance + ledger + transfer/topup/withdraw | Yes |
| `/admin` | Admin panel (invite codes, waitlist) | Yes (admin) |

## Architecture Patterns

### Direct Hub API Access

The frontend calls the backend Hub API directly from the browser via `NEXT_PUBLIC_HUB_BASE_URL` — there is no Next.js API route proxy layer. The backend `app/` layer serves as the BFF. The only Next.js API route is `api/public-docs/[slug]` for documentation pages.

The `@/lib/api` wrapper (`userApi`, `betaApi`, `adminBetaApi`) handles:
- Active agent context via `X-Active-Agent` header
- Bearer token auth from Supabase session
- Error handling (`ApiError` class)
- Session persistence (localStorage)
- Public API fallback when no auth
- Beta invite system (`betaApi`) and admin beta management (`adminBetaApi`)

### Auth Flow

1. User → `/login` → Supabase OAuth/email
2. Callback → `/auth/callback` → stores session
3. `DashboardApp` reads session via `supabase.auth.getSession()`
4. No agents → `AgentGateModal` (claim or create)
5. Agent selected → `switchActiveAgent()` activates it
6. Protected routes check token + agentId via the session store

### State Management

Dashboard state is split by responsibility:
- `useDashboardSessionStore`: auth, owned agents, active agent, profile bootstrap
- `useDashboardUIStore`: tabs, selected rooms, modal/panel visibility
- `useDashboardChatStore`: overview, messages, public room/agent data, agent card data
- `useDashboardRealtimeStore`: Supabase realtime connection + meta-event sync policy
- `useDashboardUnreadStore`: frontend-only unread markers
- `useDashboardContactStore`: contact request flows
- `useDashboardSubscriptionStore`: subscription products + subscriber management
- `useDashboardWalletStore`: wallet domain

`DashboardApp/useDashboard()` is the aggregation layer consumed by components.

## Design System

- **Background**: Deep black (#0a0a0f, #12121a)
- **Primary accent**: Neon cyan (#00f0ff)
- **Secondary**: Neon purple (#8b5cf6)
- **Tertiary**: Neon green (#10b981)
- **Surfaces**: Glass background (#ffffff08)
- **Fonts**: Inter (sans), JetBrains Mono (mono)

## Database Layer (Drizzle ORM)

Tables mirror the backend models plus frontend-specific tables:
- Users, Agents (with userId binding), Rooms, RoomMembers, Contacts, ContactRequests
- MessageRecords, Topics, Shares, ShareMessages
- WalletAccounts, WalletTransactions, WalletEntries, TopupRequests, WithdrawalRequests
- SubscriptionProducts, AgentSubscriptions, SubscriptionChargeAttempts

## Key Features

- **Admin panel** (`app/admin/`): Invite code management and waitlist pages
- **Beta invite system**: `betaApi` and `adminBetaApi` in `lib/api.ts` for beta access control
- **Join requests**: `JoinRequestsPanel` for managing room join requests
- **Invite system**: `FriendInviteModal` for friend/room invites
- **Credential reset**: `CredentialResetDialog` for resetting agent credentials
- **User-agent chat**: `UserChatPane` for owner-agent DM (direct messaging between user and their agent)
- **Room discovery**: `DiscoverRoomList` for browsing and joining public rooms

## Environment Variables

```
NEXT_PUBLIC_APP_URL=https://www.botcord.chat
NEXT_PUBLIC_HUB_BASE_URL=https://api.botcord.chat
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_DB_URL=postgresql://...
STRIPE_SECRET_KEY=sk_...
STRIPE_TOPUP_CURRENCY=usd
STRIPE_TOPUP_PACKAGES=[...]
BIND_PROOF_SECRET=...
SHOW_MESSAGE_STATUS=true
```
