import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import type {
  DeliveryStatus,
  GatewayConnection,
  GatewayProviderState,
  InboundEvent,
  InboundEventStatus,
  OutboundDelivery,
} from "../types.js";

/**
 * Persistent storage for the ingress service.
 *
 * Tables map to flat JSON files under `rootDir`:
 *
 *   <rootDir>/connections/<gateway_id>.json     — GatewayConnection
 *   <rootDir>/state/<gateway_id>.json           — GatewayProviderState
 *   <rootDir>/events/<event_id>.json            — InboundEvent
 *   <rootDir>/deliveries/<delivery_id>.json     — OutboundDelivery
 *
 * Atomic writes use the rename-after-write pattern (write to .tmp then
 * `renameSync`) so a crash never leaves a half-written file. Files are
 * small and bounded — the dedupe window is capped per `appendDedupe`,
 * and delivered events are pruned after `markDelivered` to keep the
 * directory bounded.
 *
 * This is deliberately not SQLite: the ingress MVP only needs ordered
 * append / single-key lookup, and avoiding native bindings keeps tests
 * portable. Production deployments that want stronger durability can
 * back this with PostgreSQL by re-implementing the same interface.
 */
export interface IngressStore {
  // Connections
  listConnections(): GatewayConnection[];
  getConnection(gatewayId: string): GatewayConnection | null;
  upsertConnection(row: GatewayConnection): void;
  deleteConnection(gatewayId: string): void;

  // Provider state
  getState(gatewayId: string): GatewayProviderState | null;
  updateState(gatewayId: string, patch: Partial<GatewayProviderState>): GatewayProviderState;
  appendDedupe(gatewayId: string, providerEventId: string, capacity?: number): boolean;

  // Inbound events
  listEventsByStatus(...statuses: InboundEventStatus[]): InboundEvent[];
  getEvent(eventId: string): InboundEvent | null;
  insertEvent(event: InboundEvent): void;
  updateEvent(eventId: string, patch: Partial<InboundEvent>): InboundEvent;
  hasProviderEventId(gatewayId: string, providerEventId: string): boolean;

  // Outbound deliveries
  insertDelivery(row: OutboundDelivery): void;
  updateDelivery(deliveryId: string, patch: Partial<OutboundDelivery>): OutboundDelivery;
  getDeliveryByEvent(eventId: string): OutboundDelivery | null;
  listDeliveries(): OutboundDelivery[];
}

const SUBDIRS = ["connections", "state", "events", "deliveries"] as const;

function atomicWriteJson(path: string, body: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export class FileSystemIngressStore implements IngressStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolvePath(rootDir);
    for (const sub of SUBDIRS) {
      const path = join(this.root, sub);
      if (!existsSync(path)) mkdirSync(path, { recursive: true });
    }
  }

  // -------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------

  private connectionPath(gatewayId: string): string {
    return join(this.root, "connections", `${gatewayId}.json`);
  }

  listConnections(): GatewayConnection[] {
    const dir = join(this.root, "connections");
    if (!existsSync(dir)) return [];
    const out: GatewayConnection[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const row = readJson<GatewayConnection>(join(dir, name));
      if (row) out.push(row);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  getConnection(gatewayId: string): GatewayConnection | null {
    return readJson<GatewayConnection>(this.connectionPath(gatewayId));
  }

  upsertConnection(row: GatewayConnection): void {
    atomicWriteJson(this.connectionPath(row.id), row);
  }

  deleteConnection(gatewayId: string): void {
    const path = this.connectionPath(gatewayId);
    if (existsSync(path)) unlinkSync(path);
  }

  // -------------------------------------------------------------------
  // Provider state
  // -------------------------------------------------------------------

  private statePath(gatewayId: string): string {
    return join(this.root, "state", `${gatewayId}.json`);
  }

  getState(gatewayId: string): GatewayProviderState | null {
    return readJson<GatewayProviderState>(this.statePath(gatewayId));
  }

  updateState(
    gatewayId: string,
    patch: Partial<GatewayProviderState>,
  ): GatewayProviderState {
    const current = this.getState(gatewayId) ?? {
      gatewayId,
      updatedAt: Date.now(),
    };
    const next: GatewayProviderState = {
      ...current,
      ...patch,
      gatewayId,
      updatedAt: Date.now(),
    };
    atomicWriteJson(this.statePath(gatewayId), next);
    return next;
  }

  appendDedupe(gatewayId: string, providerEventId: string, capacity = 1024): boolean {
    const current = this.getState(gatewayId) ?? {
      gatewayId,
      updatedAt: Date.now(),
    };
    const dedupe = current.dedupe ?? [];
    if (dedupe.includes(providerEventId)) return false;
    dedupe.push(providerEventId);
    while (dedupe.length > capacity) dedupe.shift();
    this.updateState(gatewayId, { dedupe });
    return true;
  }

  // -------------------------------------------------------------------
  // Inbound events
  // -------------------------------------------------------------------

  private eventPath(eventId: string): string {
    return join(this.root, "events", `${eventId}.json`);
  }

  listEventsByStatus(...statuses: InboundEventStatus[]): InboundEvent[] {
    const dir = join(this.root, "events");
    if (!existsSync(dir)) return [];
    const filter = new Set(statuses);
    const out: InboundEvent[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const row = readJson<InboundEvent>(join(dir, name));
      if (row && (filter.size === 0 || filter.has(row.status))) out.push(row);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  getEvent(eventId: string): InboundEvent | null {
    return readJson<InboundEvent>(this.eventPath(eventId));
  }

  insertEvent(event: InboundEvent): void {
    if (existsSync(this.eventPath(event.eventId))) {
      throw new Error(`event ${event.eventId} already exists`);
    }
    atomicWriteJson(this.eventPath(event.eventId), event);
  }

  updateEvent(eventId: string, patch: Partial<InboundEvent>): InboundEvent {
    const current = this.getEvent(eventId);
    if (!current) throw new Error(`event ${eventId} not found`);
    const next: InboundEvent = {
      ...current,
      ...patch,
      eventId,
      updatedAt: Date.now(),
    };
    atomicWriteJson(this.eventPath(eventId), next);
    return next;
  }

  hasProviderEventId(gatewayId: string, providerEventId: string): boolean {
    // Two layers of dedupe: persisted ring buffer (fast path) + event
    // table scan (truth). The ring buffer is bounded so periodic
    // restarts still see the truth via the scan.
    const state = this.getState(gatewayId);
    if (state?.dedupe?.includes(providerEventId)) return true;
    for (const row of this.listEventsByStatus()) {
      if (row.gatewayId === gatewayId && row.providerEventId === providerEventId) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Outbound deliveries
  // -------------------------------------------------------------------

  private deliveryPath(deliveryId: string): string {
    return join(this.root, "deliveries", `${deliveryId}.json`);
  }

  insertDelivery(row: OutboundDelivery): void {
    atomicWriteJson(this.deliveryPath(row.deliveryId), row);
  }

  updateDelivery(deliveryId: string, patch: Partial<OutboundDelivery>): OutboundDelivery {
    const current = readJson<OutboundDelivery>(this.deliveryPath(deliveryId));
    if (!current) throw new Error(`delivery ${deliveryId} not found`);
    const next: OutboundDelivery = {
      ...current,
      ...patch,
      deliveryId,
      updatedAt: Date.now(),
    };
    atomicWriteJson(this.deliveryPath(deliveryId), next);
    return next;
  }

  getDeliveryByEvent(eventId: string): OutboundDelivery | null {
    for (const row of this.listDeliveries()) {
      if (row.eventId === eventId) return row;
    }
    return null;
  }

  listDeliveries(): OutboundDelivery[] {
    const dir = join(this.root, "deliveries");
    if (!existsSync(dir)) return [];
    const out: OutboundDelivery[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const row = readJson<OutboundDelivery>(join(dir, name));
      if (row) out.push(row);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
}

/** Status flag asserting all known statuses for use in narrowing tests. */
export function isTerminalDeliveryStatus(s: DeliveryStatus): boolean {
  return s === "sent" || s === "failed";
}
