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
  /** Seen idempotency keys */
  idempotencyKeys: Map<string, any>;
  /** Known agent IDs (for transfer recipient validation) */
  knownAgents: Set<string>;
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
    idempotencyKeys: new Map(),
    knownAgents: new Set(["ag_testclient00"]),
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        token: `mock-jwt-token-${state.tokenRefreshCount}`,
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
        default_send: body.default_send ?? true,
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
      if (body.default_send !== undefined) room.default_send = body.default_send;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...room, members: [] }));
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
      // Extract agent from auth header (simplified — use a default)
      const agentId = "ag_testclient00";
      let w = state.wallets.get(agentId);
      if (!w) {
        w = { agent_id: agentId, available_balance_minor: 0, locked_balance_minor: 0 };
        state.wallets.set(agentId, w);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agent_id: w.agent_id,
        asset_code: "COIN",
        available_balance_minor: String(w.available_balance_minor),
        locked_balance_minor: String(w.locked_balance_minor),
        total_balance_minor: String(w.available_balance_minor + w.locked_balance_minor),
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    // ── Wallet: transfer ──────────────────────────────────────
    if (path === "/wallet/transfers" && method === "POST") {
      const body = await parseBody(req);
      const fromId = "ag_testclient00";
      const toId = body.to_agent_id;
      const amount = parseInt(body.amount_minor, 10);

      // Idempotency check
      if (body.idempotency_key && state.idempotencyKeys.has(body.idempotency_key)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.idempotencyKeys.get(body.idempotency_key)));
        return;
      }

      let fromW = state.wallets.get(fromId);
      if (!fromW) {
        fromW = { agent_id: fromId, available_balance_minor: 0, locked_balance_minor: 0 };
        state.wallets.set(fromId, fromW);
      }
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
      let toW = state.wallets.get(toId);
      if (!toW) {
        toW = { agent_id: toId, available_balance_minor: 0, locked_balance_minor: 0 };
        state.wallets.set(toId, toW);
      }
      toW.available_balance_minor += amount;

      const txId = uniqueId("tx_");
      const now = new Date().toISOString();
      const metadataJson = body.memo ? JSON.stringify({ memo: body.memo }) : null;
      const tx = {
        tx_id: txId,
        type: "transfer",
        status: "completed",
        asset_code: "COIN",
        amount_minor: String(amount),
        fee_minor: "0",
        from_agent_id: fromId,
        to_agent_id: toId,
        metadata_json: metadataJson,
        created_at: now,
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
      const agentId = "ag_testclient00";
      const amount = parseInt(body.amount_minor, 10);

      if (body.idempotency_key && state.idempotencyKeys.has(body.idempotency_key)) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.idempotencyKeys.get(body.idempotency_key)));
        return;
      }

      const topupId = uniqueId("tu_");
      const txId = uniqueId("tx_");
      const now = new Date().toISOString();

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
        created_at: now,
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
      let w = state.wallets.get(agentId);
      if (!w) {
        w = { agent_id: agentId, available_balance_minor: 0, locked_balance_minor: 0 };
        state.wallets.set(agentId, w);
      }
      w.available_balance_minor += topup._amount;

      const now = new Date().toISOString();
      topup.status = "completed";
      topup.completed_at = now;

      // Update transaction status
      const tx = state.walletTransactions.find((t: any) => t.tx_id === topup._txId);
      if (tx) {
        tx.status = "completed";
        tx.completed_at = now;
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
      const agentId = "ag_testclient00";
      const amount = parseInt(body.amount_minor, 10);

      if (body.idempotency_key && state.idempotencyKeys.has(body.idempotency_key)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.idempotencyKeys.get(body.idempotency_key)));
        return;
      }

      let w = state.wallets.get(agentId);
      if (!w) {
        w = { agent_id: agentId, available_balance_minor: 0, locked_balance_minor: 0 };
        state.wallets.set(agentId, w);
      }
      if (w.available_balance_minor < amount) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Insufficient balance" }));
        return;
      }

      w.available_balance_minor -= amount;
      w.locked_balance_minor += amount;

      const wdId = uniqueId("wd_");
      const txId = uniqueId("tx_");
      const now = new Date().toISOString();
      const result = {
        withdrawal_id: wdId,
        tx_id: txId,
        status: "pending",
        amount_minor: String(amount),
        fee_minor: "0",
        created_at: now,
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
        created_at: now,
        completed_at: null,
      });

      if (body.idempotency_key) {
        state.idempotencyKeys.set(body.idempotency_key, result);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Wallet: ledger ────────────────────────────────────────
    if (path === "/wallet/ledger" && method === "GET") {
      const agentId = "ag_testclient00";
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
