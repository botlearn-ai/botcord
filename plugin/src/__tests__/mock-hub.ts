/**
 * Lightweight mock Hub server for integration tests.
 * Simulates key Hub API endpoints with in-memory state.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockWallet {
  agent_id: string;
  available_balance_minor: number;
  locked_balance_minor: number;
}

export interface MockSubscriptionProduct {
  product_id: string;
  owner_agent_id: string;
  name: string;
  description: string;
  asset_code: string;
  amount_minor: number;
  billing_interval: "week" | "month";
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface MockSubscription {
  subscription_id: string;
  product_id: string;
  subscriber_agent_id: string;
  provider_agent_id: string;
  asset_code: string;
  amount_minor: number;
  billing_interval: "week" | "month";
  status: "active" | "past_due" | "cancelled";
  current_period_start: string;
  current_period_end: string;
  next_charge_at: string;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  last_charged_at: string | null;
  last_charge_tx_id: string | null;
  consecutive_failed_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface MockSubscriptionChargeAttempt {
  attempt_id: string;
  subscription_id: string;
  billing_cycle_key: string;
  status: "pending" | "succeeded" | "failed";
  scheduled_at: string;
  attempted_at: string | null;
  tx_id: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface MockHubState {
  /** Sent messages stored here */
  messages: Array<{ envelope: any; topic?: string }>;
  /** Messages queued for inbox poll */
  inbox: any[];
  /** Registered endpoints */
  endpoints: Array<{ url: string; webhook_token?: string }>;
  /** Rooms */
  rooms: any[];
  /** Contacts */
  contacts: any[];
  /** Token refresh call count (for testing retry/re-auth) */
  tokenRefreshCount: number;
  /** Custom response overrides by path pattern */
  overrides: Map<string, { status: number; body: any; headers?: Record<string, string> }>;
  /** Wallets keyed by agent_id */
  wallets: Map<string, MockWallet>;
  /** Wallet transactions */
  walletTransactions: any[];
  /** Wallet ledger entries */
  walletEntries: any[];
  /** Subscription products */
  subscriptionProducts: MockSubscriptionProduct[];
  /** Active subscriptions */
  subscriptions: MockSubscription[];
  /** Billing attempts, keyed by subscription_id + billing_cycle_key */
  subscriptionChargeAttempts: Map<string, MockSubscriptionChargeAttempt>;
  /** Seen idempotency keys */
  idempotencyKeys: Map<string, any>;
  /** Known agent IDs (for transfer recipient validation) */
  knownAgents: Set<string>;
  /** JWT token to agent mapping */
  tokens: Map<string, string>;
  /** Last observed history query params */
  lastHistoryQuery?: Record<string, string>;
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

let _idCounter = 0;
function uniqueId(prefix: string): string {
  return `${prefix}${Date.now()}_${++_idCounter}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function getAgentIdFromRequest(req: IncomingMessage, state: MockHubState): string {
  const token = getBearerToken(req);
  if (token && state.tokens.has(token)) {
    return state.tokens.get(token)!;
  }
  return "ag_testclient00";
}

function ensureWallet(state: MockHubState, agentId: string): MockWallet {
  let wallet = state.wallets.get(agentId);
  if (!wallet) {
    wallet = { agent_id: agentId, available_balance_minor: 0, locked_balance_minor: 0 };
    state.wallets.set(agentId, wallet);
  }
  return wallet;
}

function addInterval(baseIso: string, interval: "week" | "month"): string {
  const date = new Date(baseIso);
  if (interval === "week") {
    date.setUTCDate(date.getUTCDate() + 7);
    return date.toISOString();
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, month + 1, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

function productResponse(product: MockSubscriptionProduct) {
  return {
    ...product,
    amount_minor: String(product.amount_minor),
  };
}

function subscriptionResponse(subscription: MockSubscription) {
  return {
    ...subscription,
    amount_minor: String(subscription.amount_minor),
  };
}

function recordWalletTx(state: MockHubState, tx: Record<string, any>) {
  state.walletTransactions.push(tx);
}

function writeLedgerEntry(
  state: MockHubState,
  entry: {
    entry_id: string;
    tx_id: string;
    agent_id: string;
    asset_code: string;
    direction: "debit" | "credit";
    amount_minor: string;
    balance_after_minor: string;
    created_at: string;
  },
) {
  state.walletEntries.push(entry);
}

function makeChargeTx(
  fromId: string,
  toId: string,
  amount: number,
  now: string,
  referenceType: string,
  referenceId: string,
  metadata: Record<string, unknown>,
): Record<string, any> {
  return {
    tx_id: uniqueId("tx_"),
    type: "transfer",
    status: "completed",
    asset_code: "COIN",
    amount_minor: String(amount),
    fee_minor: "0",
    from_agent_id: fromId,
    to_agent_id: toId,
    reference_type: referenceType,
    reference_id: referenceId,
    idempotency_key: null,
    metadata_json: JSON.stringify(metadata),
    created_at: now,
    updated_at: now,
    completed_at: now,
  };
}

function chargeSubscription(
  state: MockHubState,
  subscription: MockSubscription,
  now: string,
  billingCycleKey: string,
  phase: "initial" | "renewal",
): { ok: true; txId: string } | { ok: false; reason: string } {
  const attemptKey = `${subscription.subscription_id}:${billingCycleKey}`;
  const existingAttempt = state.subscriptionChargeAttempts.get(attemptKey);
  if (existingAttempt?.status === "succeeded") {
    return { ok: true, txId: existingAttempt.tx_id! };
  }

  const subscriberWallet = ensureWallet(state, subscription.subscriber_agent_id);
  const providerWallet = ensureWallet(state, subscription.provider_agent_id);
  const amount = subscription.amount_minor;

  if (subscriberWallet.available_balance_minor < amount) {
    const failedAttempt: MockSubscriptionChargeAttempt = existingAttempt ?? {
      attempt_id: uniqueId("sa_"),
      subscription_id: subscription.subscription_id,
      billing_cycle_key: billingCycleKey,
      status: "pending",
      scheduled_at: billingCycleKey,
      attempted_at: null,
      tx_id: null,
      failure_reason: null,
      created_at: now,
    };
    failedAttempt.status = "failed";
    failedAttempt.attempted_at = now;
    failedAttempt.failure_reason = "Insufficient balance";
    state.subscriptionChargeAttempts.set(attemptKey, failedAttempt);
    return { ok: false, reason: "Insufficient balance" };
  }

  subscriberWallet.available_balance_minor -= amount;
  providerWallet.available_balance_minor += amount;

  const tx = makeChargeTx(
    subscription.subscriber_agent_id,
    subscription.provider_agent_id,
    amount,
    now,
    "subscription_charge",
    subscription.subscription_id,
    {
      kind: "subscription_charge",
      subscription_id: subscription.subscription_id,
      product_id: subscription.product_id,
      billing_cycle_key: billingCycleKey,
      phase,
    },
  );
  recordWalletTx(state, tx);

  writeLedgerEntry(state, {
    entry_id: uniqueId("we_"),
    tx_id: tx.tx_id,
    agent_id: subscription.subscriber_agent_id,
    asset_code: "COIN",
    direction: "debit",
    amount_minor: String(amount),
    balance_after_minor: String(subscriberWallet.available_balance_minor),
    created_at: now,
  });
  writeLedgerEntry(state, {
    entry_id: uniqueId("we_"),
    tx_id: tx.tx_id,
    agent_id: subscription.provider_agent_id,
    asset_code: "COIN",
    direction: "credit",
    amount_minor: String(amount),
    balance_after_minor: String(providerWallet.available_balance_minor),
    created_at: now,
  });

  const attempt: MockSubscriptionChargeAttempt = existingAttempt ?? {
    attempt_id: uniqueId("sa_"),
    subscription_id: subscription.subscription_id,
    billing_cycle_key: billingCycleKey,
    status: "pending",
    scheduled_at: billingCycleKey,
    attempted_at: null,
    tx_id: null,
    failure_reason: null,
    created_at: now,
  };
  attempt.status = "succeeded";
  attempt.attempted_at = now;
  attempt.tx_id = tx.tx_id;
  attempt.failure_reason = null;
  state.subscriptionChargeAttempts.set(attemptKey, attempt);

  return { ok: true, txId: tx.tx_id };
}

export function createMockHub() {
  const state: MockHubState = {
    messages: [],
    inbox: [],
    endpoints: [],
    rooms: [],
    contacts: [],
    tokenRefreshCount: 0,
    overrides: new Map(),
    wallets: new Map(),
    walletTransactions: [],
    walletEntries: [],
    subscriptionProducts: [],
    subscriptions: [],
    subscriptionChargeAttempts: new Map(),
    idempotencyKeys: new Map(),
    knownAgents: new Set(["ag_testclient00"]),
    tokens: new Map(),
    lastHistoryQuery: undefined,
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    const method = req.method || "GET";

    // Check for overrides first
    for (const [pattern, override] of state.overrides) {
      if (path.includes(pattern)) {
        res.writeHead(override.status, {
          "Content-Type": "application/json",
          ...(override.headers || {}),
        });
        res.end(JSON.stringify(override.body));
        return;
      }
    }

    // ── Token refresh ──────────────────────────────────────────
    if (path.includes("/token/refresh") && method === "POST") {
      state.tokenRefreshCount++;
      const agentId = path.split("/")[3] || "ag_testclient00";
      state.knownAgents.add(agentId);
      const token = `mock-jwt-token-${state.tokenRefreshCount}-${agentId}`;
      state.tokens.set(token, agentId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        token,
        agent_token: token,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      }));
      return;
    }

    // ── Send message ───────────────────────────────────────────
    if (path === "/hub/send" && method === "POST") {
      const body = await parseBody(req);
      const topic = url.searchParams.get("topic") || undefined;
      state.messages.push({ envelope: body, topic });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        queued: true,
        hub_msg_id: `hub_${Date.now()}`,
        status: "queued",
      }));
      return;
    }

    // ── Poll inbox ─────────────────────────────────────────────
    if (path === "/hub/inbox" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const ack = url.searchParams.get("ack") === "true";
      const msgs = state.inbox.slice(0, limit);
      if (ack) state.inbox.splice(0, msgs.length);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        messages: msgs,
        count: msgs.length,
        has_more: state.inbox.length > msgs.length,
      }));
      return;
    }

    // ── History ────────────────────────────────────────────────
    if (path === "/hub/history" && method === "GET") {
      state.lastHistoryQuery = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: state.messages.map((m) => m.envelope) }));
      return;
    }

    // ── Resolve agent ──────────────────────────────────────────
    if (path.startsWith("/registry/resolve/") && method === "GET") {
      const agentId = path.split("/").pop()!;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agent_id: agentId,
        display_name: `Agent ${agentId}`,
        bio: "mock agent",
        message_policy: "open",
        endpoints: [],
      }));
      return;
    }

    // ── Register endpoint ──────────────────────────────────────
    if (path.includes("/endpoints") && method === "POST") {
      const body = await parseBody(req);
      state.endpoints.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Contacts ───────────────────────────────────────────────
    if (path.includes("/contacts") && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.contacts));
      return;
    }

    // ── Rooms ──────────────────────────────────────────────────
    if (path === "/hub/rooms" && method === "POST") {
      const body = await parseBody(req);
      const room = {
        room_id: `rm_${Date.now()}`,
        name: body.name,
        description: body.description || "",
        rule: body.rule ?? null,
        visibility: body.visibility || "private",
        join_policy: body.join_policy || "invite_only",
        required_subscription_product_id: body.required_subscription_product_id ?? null,
        max_members: body.max_members ?? null,
        default_send: body.default_send ?? true,
        default_invite: body.default_invite ?? false,
        slow_mode_seconds: body.slow_mode_seconds ?? null,
        member_count: 1,
        created_at: new Date().toISOString(),
      };
      state.rooms.push(room);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(room));
      return;
    }

    if (path === "/hub/rooms/me" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.rooms));
      return;
    }

    if (path.startsWith("/hub/rooms/rm_") && method === "GET") {
      const roomId = path.split("/").pop()!;
      const room = state.rooms.find((r) => r.room_id === roomId);
      if (room) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...room, members: [] }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }

    if (path.startsWith("/hub/rooms/rm_") && method === "PATCH") {
      const roomId = path.split("/").pop()!;
      const room = state.rooms.find((r) => r.room_id === roomId);
      if (!room) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const body = await parseBody(req);
      if (body.name !== undefined) room.name = body.name;
      if (body.description !== undefined) room.description = body.description;
      if (body.rule !== undefined) room.rule = body.rule;
      if (body.visibility !== undefined) room.visibility = body.visibility;
      if (body.join_policy !== undefined) room.join_policy = body.join_policy;
      if (body.required_subscription_product_id !== undefined) {
        room.required_subscription_product_id = body.required_subscription_product_id;
      }
      if (body.max_members !== undefined) room.max_members = body.max_members;
      if (body.default_send !== undefined) room.default_send = body.default_send;
      if (body.default_invite !== undefined) room.default_invite = body.default_invite;
      if (body.slow_mode_seconds !== undefined) room.slow_mode_seconds = body.slow_mode_seconds;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...room, members: [] }));
      return;
    }

    if (path.match(/^\/hub\/rooms\/rm_[^/]+\/mute$/) && method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Blocks ─────────────────────────────────────────────────
    if (path.includes("/blocks") && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    // ── Contact requests ───────────────────────────────────────
    if (path.includes("/contact-requests/") && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    if (path.includes("/accept") || path.includes("/reject")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Wallet: get balance ──────────────────────────────────────
    if (path === "/wallet/me" && method === "GET") {
      const agentId = getAgentIdFromRequest(req, state);
      const w = ensureWallet(state, agentId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agent_id: w.agent_id,
        asset_code: "COIN",
        available_balance_minor: String(w.available_balance_minor),
        locked_balance_minor: String(w.locked_balance_minor),
        total_balance_minor: String(w.available_balance_minor + w.locked_balance_minor),
        updated_at: nowIso(),
      }));
      return;
    }

    // ── Wallet: transfer ──────────────────────────────────────
    if (path === "/wallet/transfers" && method === "POST") {
      const body = await parseBody(req);
      const fromId = getAgentIdFromRequest(req, state);
      const toId = body.to_agent_id;
      const amount = parseInt(body.amount_minor, 10);

      // Idempotency check
      if (body.idempotency_key && state.idempotencyKeys.has(body.idempotency_key)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.idempotencyKeys.get(body.idempotency_key)));
        return;
      }

      const fromW = ensureWallet(state, fromId);
      if (fromId === toId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Cannot transfer to yourself" }));
        return;
      }
      if (!state.knownAgents.has(toId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Recipient agent not found" }));
        return;
      }
      if (amount <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Amount must be positive" }));
        return;
      }
      if (fromW.available_balance_minor < amount) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Insufficient balance" }));
        return;
      }

      fromW.available_balance_minor -= amount;
      const toW = ensureWallet(state, toId);
      toW.available_balance_minor += amount;

      const txId = uniqueId("tx_");
      const now = nowIso();
      const metadata = {
        ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
        ...(body.memo ? { memo: body.memo } : {}),
      };
      const metadataJson = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
      const tx = {
        tx_id: txId,
        type: "transfer",
        status: "completed",
        asset_code: "COIN",
        amount_minor: String(amount),
        fee_minor: "0",
        from_agent_id: fromId,
        to_agent_id: toId,
        reference_type: body.reference_type ?? null,
        reference_id: body.reference_id ?? null,
        idempotency_key: body.idempotency_key ?? null,
        metadata_json: metadataJson,
        created_at: now,
        updated_at: now,
        completed_at: now,
      };
      state.walletTransactions.push(tx);

      // Ledger entries
      state.walletEntries.push({
        entry_id: uniqueId("we_"),
        tx_id: txId,
        agent_id: fromId,
        asset_code: "COIN",
        direction: "debit",
        amount_minor: String(amount),
        balance_after_minor: String(fromW.available_balance_minor),
        created_at: now,
      });
      state.walletEntries.push({
        entry_id: uniqueId("we_"),
        tx_id: txId,
        agent_id: toId,
        asset_code: "COIN",
        direction: "credit",
        amount_minor: String(amount),
        balance_after_minor: String(toW.available_balance_minor),
        created_at: now,
      });

      if (body.idempotency_key) {
        state.idempotencyKeys.set(body.idempotency_key, tx);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tx));
      return;
    }

    // ── Wallet: topup (creates pending request, does NOT credit wallet) ──
    if (path === "/wallet/topups" && method === "POST") {
      const body = await parseBody(req);
      const agentId = getAgentIdFromRequest(req, state);
      const amount = parseInt(body.amount_minor, 10);

      if (body.idempotency_key && state.idempotencyKeys.has(body.idempotency_key)) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.idempotencyKeys.get(body.idempotency_key)));
        return;
      }

      const topupId = uniqueId("tu_");
      const txId = uniqueId("tx_");
      const now = nowIso();

      // Pending transaction — balance NOT changed yet
      const tx = {
        tx_id: txId,
        type: "topup",
        status: "pending",
        asset_code: "COIN",
        amount_minor: String(amount),
        fee_minor: "0",
        from_agent_id: null,
        to_agent_id: agentId,
        reference_type: null,
        reference_id: null,
        idempotency_key: body.idempotency_key ?? null,
        metadata_json: body.metadata ? JSON.stringify(body.metadata) : null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      };
      state.walletTransactions.push(tx);

      const result = {
        topup_id: topupId,
        tx_id: txId,
        agent_id: agentId,
        asset_code: "COIN",
        amount_minor: String(amount),
        status: "pending",
        channel: body.channel || "mock",
        created_at: now,
        completed_at: null,
      };
      if (body.idempotency_key) {
        state.idempotencyKeys.set(body.idempotency_key, result);
      }

      // Store topup for internal complete endpoint
      (state as any)._topups = (state as any)._topups || new Map();
      (state as any)._topups.set(topupId, { ...result, _amount: amount, _agentId: agentId, _txId: txId });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Internal: complete topup ──────────────────────────────
    if (path.match(/^\/internal\/wallet\/topups\/tu_[^/]+\/complete$/) && method === "POST") {
      const topupId = path.split("/")[4];
      const topups = (state as any)._topups as Map<string, any> | undefined;
      const topup = topups?.get(topupId);
      if (!topup || topup.status === "completed") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Topup not found or already completed" }));
        return;
      }

      // Now credit the wallet
      const agentId = topup._agentId;
      const w = ensureWallet(state, agentId);
      w.available_balance_minor += topup._amount;

      const now = nowIso();
      topup.status = "completed";
      topup.completed_at = now;

      // Update transaction status
      const tx = state.walletTransactions.find((t: any) => t.tx_id === topup._txId);
      if (tx) {
        tx.status = "completed";
        tx.completed_at = now;
        tx.updated_at = now;
      }

      // Write ledger entry
      state.walletEntries.push({
        entry_id: uniqueId("we_"),
        tx_id: topup._txId,
        agent_id: agentId,
        asset_code: "COIN",
        direction: "credit",
        amount_minor: String(topup._amount),
        balance_after_minor: String(w.available_balance_minor),
        created_at: now,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(topup));
      return;
    }

    // ── Wallet: withdrawal ────────────────────────────────────
    if (path === "/wallet/withdrawals" && method === "POST") {
      const body = await parseBody(req);
      const agentId = getAgentIdFromRequest(req, state);
      const amount = parseInt(body.amount_minor, 10);

      if (body.idempotency_key && state.idempotencyKeys.has(body.idempotency_key)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.idempotencyKeys.get(body.idempotency_key)));
        return;
      }

      const w = ensureWallet(state, agentId);
      if (w.available_balance_minor < amount) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Insufficient balance" }));
        return;
      }

      w.available_balance_minor -= amount;
      w.locked_balance_minor += amount;

      const wdId = uniqueId("wd_");
      const txId = uniqueId("tx_");
      const now = nowIso();
      const result = {
        withdrawal_id: wdId,
        tx_id: txId,
        agent_id: agentId,
        asset_code: "COIN",
        status: "pending",
        amount_minor: String(amount),
        fee_minor: String(body.fee_minor ?? "0"),
        destination_type: body.destination_type ?? null,
        review_note: null,
        created_at: now,
        reviewed_at: null,
        completed_at: null,
      };
      state.walletTransactions.push({
        tx_id: txId,
        type: "withdrawal",
        status: "pending",
        asset_code: "COIN",
        amount_minor: String(amount),
        fee_minor: "0",
        from_agent_id: agentId,
        to_agent_id: null,
        reference_type: null,
        reference_id: null,
        idempotency_key: body.idempotency_key ?? null,
        metadata_json: body.destination ? JSON.stringify(body.destination) : null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      });

      if (body.idempotency_key) {
        state.idempotencyKeys.set(body.idempotency_key, result);
      }

      (state as any)._withdrawals = (state as any)._withdrawals || new Map();
      (state as any)._withdrawals.set(wdId, { ...result, _amount: amount, _agentId: agentId, _txId: txId });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Wallet: cancel withdrawal ─────────────────────────────
    if (path.match(/^\/wallet\/withdrawals\/wd_[^/]+\/cancel$/) && method === "POST") {
      const withdrawalId = path.split("/")[3];
      const currentAgent = getAgentIdFromRequest(req, state);
      const withdrawals = (state as any)._withdrawals as Map<string, any> | undefined;
      const withdrawal = withdrawals?.get(withdrawalId);
      const tx = state.walletTransactions.find((item: any) => item.tx_id === withdrawal?._txId);
      const wallet = ensureWallet(state, currentAgent);
      const amount = withdrawal?._amount ?? 0;

      if (!withdrawal || withdrawal.agent_id !== currentAgent || !tx || tx.status !== "pending") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Withdrawal not found or cannot be cancelled" }));
        return;
      }

      wallet.available_balance_minor += amount;
      wallet.locked_balance_minor -= amount;
      tx.status = "cancelled";
      tx.updated_at = nowIso();
      withdrawal.status = "cancelled";

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        withdrawal_id: withdrawalId,
        tx_id: tx.tx_id,
        agent_id: currentAgent,
        asset_code: "COIN",
        amount_minor: tx.amount_minor,
        fee_minor: tx.fee_minor,
        status: "cancelled",
        destination_type: withdrawal.destination_type,
        review_note: withdrawal.review_note,
        created_at: tx.created_at,
        reviewed_at: withdrawal.reviewed_at,
        completed_at: withdrawal.completed_at,
      }));
      return;
    }

    // ── Subscriptions: products ────────────────────────────────
    if (path === "/subscriptions/products" && method === "POST") {
      const body = await parseBody(req);
      const ownerAgentId = getAgentIdFromRequest(req, state);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description = typeof body.description === "string" ? body.description : "";
      const amount = parseInt(body.amount_minor, 10);
      const billingInterval = body.billing_interval;
      const assetCode = body.asset_code || "COIN";

      if (!name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "name is required" }));
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "amount_minor must be positive" }));
        return;
      }
      if (billingInterval !== "week" && billingInterval !== "month") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "billing_interval must be week or month" }));
        return;
      }

      const now = nowIso();
      const product: MockSubscriptionProduct = {
        product_id: uniqueId("sp_"),
        owner_agent_id: ownerAgentId,
        name,
        description,
        asset_code: assetCode,
        amount_minor: amount,
        billing_interval: billingInterval,
        status: "active",
        created_at: now,
        updated_at: now,
        archived_at: null,
      };
      state.subscriptionProducts.push(product);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(productResponse(product)));
      return;
    }

    if (path === "/subscriptions/products/me" && method === "GET") {
      const agentId = getAgentIdFromRequest(req, state);
      const products = state.subscriptionProducts.filter((product) => product.owner_agent_id === agentId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(products.map(productResponse)));
      return;
    }

    if (path === "/subscriptions/products" && method === "GET") {
      const products = state.subscriptionProducts.filter((product) => product.status === "active");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(products.map(productResponse)));
      return;
    }

    if (path.match(/^\/subscriptions\/products\/sp_[^/]+\/archive$/) && method === "POST") {
      const productId = path.split("/")[3];
      const agentId = getAgentIdFromRequest(req, state);
      const product = state.subscriptionProducts.find((item) => item.product_id === productId);
      if (!product) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Product not found" }));
        return;
      }
      if (product.owner_agent_id !== agentId) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Not authorized" }));
        return;
      }
      if (product.status === "archived") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(productResponse(product)));
        return;
      }
      product.status = "archived";
      product.updated_at = nowIso();
      product.archived_at = product.updated_at;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(productResponse(product)));
      return;
    }

    // ── Subscriptions: subscription instances ──────────────────
    if (path.match(/^\/subscriptions\/products\/sp_[^/]+\/subscribe$/) && method === "POST") {
      const productId = path.split("/")[3];
      const subscriberAgentId = getAgentIdFromRequest(req, state);
      const product = state.subscriptionProducts.find((item) => item.product_id === productId);
      if (!product) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Product not found" }));
        return;
      }
      if (product.status !== "active") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Product is archived" }));
        return;
      }
      if (product.owner_agent_id === subscriberAgentId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Cannot subscribe to your own product" }));
        return;
      }

      const existing = state.subscriptions.find(
        (subscription) =>
          subscription.product_id === productId &&
          subscription.subscriber_agent_id === subscriberAgentId,
      );
      if (existing) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(subscriptionResponse(existing)));
        return;
      }

      const now = nowIso();
      const currentPeriodEnd = addInterval(now, product.billing_interval);
      const subscription: MockSubscription = {
        subscription_id: uniqueId("su_"),
        product_id: product.product_id,
        subscriber_agent_id: subscriberAgentId,
        provider_agent_id: product.owner_agent_id,
        asset_code: product.asset_code,
        amount_minor: product.amount_minor,
        billing_interval: product.billing_interval,
        status: "active",
        current_period_start: now,
        current_period_end: currentPeriodEnd,
        next_charge_at: currentPeriodEnd,
        cancel_at_period_end: false,
        cancelled_at: null,
        last_charged_at: null,
        last_charge_tx_id: null,
        consecutive_failed_attempts: 0,
        created_at: now,
        updated_at: now,
      };

      const charge = chargeSubscription(state, subscription, now, `initial:${subscription.subscription_id}`, "initial");
      if (!charge.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: charge.reason }));
        return;
      }

      subscription.last_charged_at = now;
      subscription.last_charge_tx_id = charge.txId;
      state.subscriptions.push(subscription);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(subscriptionResponse(subscription)));
      return;
    }

    if (path === "/subscriptions/me" && method === "GET") {
      const agentId = getAgentIdFromRequest(req, state);
      const subscriptions = state.subscriptions.filter((subscription) => subscription.subscriber_agent_id === agentId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(subscriptions.map(subscriptionResponse)));
      return;
    }

    if (path.match(/^\/subscriptions\/products\/sp_[^/]+\/subscribers$/) && method === "GET") {
      const productId = path.split("/")[3];
      const agentId = getAgentIdFromRequest(req, state);
      const product = state.subscriptionProducts.find((item) => item.product_id === productId);
      if (!product) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Product not found" }));
        return;
      }
      if (product.owner_agent_id !== agentId) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Not authorized" }));
        return;
      }
      const subscriptions = state.subscriptions.filter((subscription) => subscription.product_id === productId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(subscriptions.map(subscriptionResponse)));
      return;
    }

    if (path.match(/^\/subscriptions\/su_[^/]+\/cancel$/) && method === "POST") {
      const subscriptionId = path.split("/")[2];
      const agentId = getAgentIdFromRequest(req, state);
      const subscription = state.subscriptions.find((item) => item.subscription_id === subscriptionId);
      if (!subscription) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Subscription not found" }));
        return;
      }
      if (subscription.subscriber_agent_id !== agentId) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Not authorized" }));
        return;
      }
      if (subscription.status === "cancelled") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(subscriptionResponse(subscription)));
        return;
      }
      subscription.status = "cancelled";
      subscription.cancelled_at = nowIso();
      subscription.updated_at = subscription.cancelled_at;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(subscriptionResponse(subscription)));
      return;
    }

    if (path === "/internal/subscriptions/run-billing" && method === "POST") {
      const now = nowIso();
      let processed = 0;
      let charged = 0;
      let failed = 0;
      let cancelled = 0;

      for (const subscription of state.subscriptions) {
        if (subscription.status === "cancelled") continue;
        if (subscription.next_charge_at > now) continue;

        const billingCycleKey = subscription.next_charge_at;
        const attemptKey = `${subscription.subscription_id}:${billingCycleKey}`;
        const existingAttempt = state.subscriptionChargeAttempts.get(attemptKey);
        if (existingAttempt) {
          continue;
        }

        processed += 1;
        const charge = chargeSubscription(state, subscription, now, billingCycleKey, "renewal");
        if (charge.ok) {
          charged += 1;
          const previousPeriodEnd = subscription.current_period_end;
          subscription.current_period_start = previousPeriodEnd;
          subscription.current_period_end = addInterval(previousPeriodEnd, subscription.billing_interval);
          subscription.next_charge_at = subscription.current_period_end;
          subscription.last_charged_at = now;
          subscription.last_charge_tx_id = charge.txId;
          subscription.consecutive_failed_attempts = 0;
          subscription.status = "active";
          subscription.updated_at = now;
        } else {
          failed += 1;
          subscription.consecutive_failed_attempts += 1;
          subscription.status = subscription.consecutive_failed_attempts >= 3 ? "cancelled" : "past_due";
          if (subscription.status === "cancelled") {
            subscription.cancelled_at = now;
            subscription.cancel_at_period_end = false;
            cancelled += 1;
          }
          const retryAt = new Date(now);
          retryAt.setUTCHours(retryAt.getUTCHours() + 24);
          subscription.next_charge_at = retryAt.toISOString();
          subscription.updated_at = now;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ processed, charged, failed, cancelled }));
      return;
    }

    // ── Wallet: ledger ────────────────────────────────────────
    if (path === "/wallet/ledger" && method === "GET") {
      const agentId = getAgentIdFromRequest(req, state);
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const typeFilter = url.searchParams.get("type");
      let entries = state.walletEntries.filter((e: any) => e.agent_id === agentId);
      if (typeFilter) {
        const matchingTxIds = new Set(
          state.walletTransactions.filter((t: any) => t.type === typeFilter).map((t: any) => t.tx_id),
        );
        entries = entries.filter((e: any) => matchingTxIds.has(e.tx_id));
      }
      const sliced = entries.slice(0, limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        entries: sliced,
        next_cursor: sliced.length < entries.length ? "next" : null,
        has_more: sliced.length < entries.length,
      }));
      return;
    }

    // ── Wallet: transaction detail ────────────────────────────
    if (path.startsWith("/wallet/transactions/") && method === "GET") {
      const txId = path.split("/").pop()!;
      const tx = state.walletTransactions.find((t: any) => t.tx_id === txId);
      if (tx) {
        const currentAgent = getAgentIdFromRequest(req, state);
        if (tx.from_agent_id !== currentAgent && tx.to_agent_id !== currentAgent) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "Not authorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tx));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Transaction not found" }));
      }
      return;
    }

    // ── Fallback ───────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", path }));
  });

  return {
    state,
    /** Start the server on a random port, returns the base URL */
    async start(): Promise<string> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    },
    async stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
