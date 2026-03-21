import { backendDb } from "@/../db/backend";
import {
  subscriptionProducts,
  agentSubscriptions,
  subscriptionChargeAttempts,
} from "@/../db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  generateSubscriptionProductId,
  generateSubscriptionId,
  generateChargeAttemptId,
} from "@/lib/id-generators";
import { createTransfer } from "./wallet";

// ---------------------------------------------------------------------------
// createSubscriptionProduct
// ---------------------------------------------------------------------------
export async function createSubscriptionProduct(
  ownerAgentId: string,
  opts: {
    name: string;
    description?: string;
    amountMinor: number;
    billingInterval: string;
  },
) {
  if (opts.amountMinor <= 0) {
    throw new SubscriptionError("amount_minor must be positive", 400);
  }

  if (!["week", "month"].includes(opts.billingInterval)) {
    throw new SubscriptionError(
      "billing_interval must be 'week' or 'month'",
      400,
    );
  }

  const productId = generateSubscriptionProductId();

  const [row] = await backendDb
    .insert(subscriptionProducts)
    .values({
      productId,
      ownerAgentId,
      name: opts.name,
      description: opts.description ?? "",
      amountMinor: opts.amountMinor,
      billingInterval: opts.billingInterval,
    })
    .returning();

  return formatProduct(row!);
}

// ---------------------------------------------------------------------------
// listSubscriptionProducts
// ---------------------------------------------------------------------------
export async function listSubscriptionProducts(
  opts: { ownerAgentId?: string } = {},
) {
  const conditions = [eq(subscriptionProducts.status, "active")];
  if (opts.ownerAgentId) {
    conditions.push(eq(subscriptionProducts.ownerAgentId, opts.ownerAgentId));
  }

  const rows = await backendDb
    .select()
    .from(subscriptionProducts)
    .where(and(...conditions))
    .orderBy(desc(subscriptionProducts.createdAt));

  return rows.map(formatProduct);
}

// ---------------------------------------------------------------------------
// archiveSubscriptionProduct
// ---------------------------------------------------------------------------
export async function archiveSubscriptionProduct(
  productId: string,
  currentAgentId: string,
) {
  const [product] = await backendDb
    .select()
    .from(subscriptionProducts)
    .where(eq(subscriptionProducts.productId, productId))
    .limit(1);

  if (!product) {
    throw new SubscriptionError("Product not found", 404);
  }

  if (product.ownerAgentId !== currentAgentId) {
    throw new SubscriptionError("Not the product owner", 403);
  }

  if (product.status === "archived") {
    throw new SubscriptionError("Product is already archived", 400);
  }

  const now = new Date();
  await backendDb
    .update(subscriptionProducts)
    .set({ status: "archived", archivedAt: now, updatedAt: now })
    .where(eq(subscriptionProducts.productId, productId));

  return { product_id: productId, status: "archived" };
}

// ---------------------------------------------------------------------------
// getSubscriptionProduct
// ---------------------------------------------------------------------------
export async function getSubscriptionProduct(productId: string) {
  const [product] = await backendDb
    .select()
    .from(subscriptionProducts)
    .where(eq(subscriptionProducts.productId, productId))
    .limit(1);

  if (!product) return null;
  return formatProduct(product);
}

// ---------------------------------------------------------------------------
// listMySubscriptions
// ---------------------------------------------------------------------------
export async function listMySubscriptions(agentId: string) {
  const rows = await backendDb
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.subscriberAgentId, agentId))
    .orderBy(desc(agentSubscriptions.createdAt));

  return rows.map(formatSubscription);
}

// ---------------------------------------------------------------------------
// listProductSubscribers
// ---------------------------------------------------------------------------
export async function listProductSubscribers(productId: string) {
  const rows = await backendDb
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.productId, productId))
    .orderBy(desc(agentSubscriptions.createdAt));

  return rows.map(formatSubscription);
}

// ---------------------------------------------------------------------------
// createSubscription
// ---------------------------------------------------------------------------
export async function createSubscription(
  productId: string,
  subscriberAgentId: string,
  idempotencyKey?: string,
) {
  const [product] = await backendDb
    .select()
    .from(subscriptionProducts)
    .where(eq(subscriptionProducts.productId, productId))
    .limit(1);

  if (!product) {
    throw new SubscriptionError("Product not found", 404);
  }

  if (product.status !== "active") {
    throw new SubscriptionError("Product is not active", 400);
  }

  if (product.ownerAgentId === subscriberAgentId) {
    throw new SubscriptionError("Cannot subscribe to own product", 400);
  }

  // Check for existing active subscription
  const [existing] = await backendDb
    .select()
    .from(agentSubscriptions)
    .where(
      and(
        eq(agentSubscriptions.productId, productId),
        eq(agentSubscriptions.subscriberAgentId, subscriberAgentId),
      ),
    )
    .limit(1);

  if (existing && existing.status === "active") {
    throw new SubscriptionError("Already subscribed", 409);
  }

  // Initial charge via wallet transfer
  const transferResult = await createTransfer(
    subscriberAgentId,
    product.ownerAgentId,
    product.amountMinor,
    {
      referenceType: "subscription",
      referenceId: productId,
      idempotencyKey: idempotencyKey
        ? `sub_init_${idempotencyKey}`
        : undefined,
    },
  );

  const now = new Date();
  const periodEnd = advancePeriod(now, product.billingInterval);
  const subscriptionId = generateSubscriptionId();

  const [sub] = await backendDb
    .insert(agentSubscriptions)
    .values({
      subscriptionId,
      productId,
      subscriberAgentId,
      providerAgentId: product.ownerAgentId,
      assetCode: product.assetCode,
      amountMinor: product.amountMinor,
      billingInterval: product.billingInterval,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      nextChargeAt: periodEnd,
      lastChargedAt: now,
      lastChargeTxId: transferResult.tx_id,
    })
    .returning();

  // Record charge attempt
  const cycleKey = `${subscriptionId}:${now.toISOString().slice(0, 10)}`;
  await backendDb.insert(subscriptionChargeAttempts).values({
    attemptId: generateChargeAttemptId(),
    subscriptionId,
    billingCycleKey: cycleKey,
    status: "completed",
    scheduledAt: now,
    attemptedAt: now,
    txId: transferResult.tx_id,
    attemptCount: 1,
  });

  return formatSubscription(sub!);
}

// ---------------------------------------------------------------------------
// cancelSubscription
// ---------------------------------------------------------------------------
export async function cancelSubscription(
  subscriptionId: string,
  currentAgentId: string,
) {
  const [sub] = await backendDb
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.subscriptionId, subscriptionId))
    .limit(1);

  if (!sub) {
    throw new SubscriptionError("Subscription not found", 404);
  }

  // Allow cancellation by subscriber or provider
  if (
    sub.subscriberAgentId !== currentAgentId &&
    sub.providerAgentId !== currentAgentId
  ) {
    throw new SubscriptionError("Not authorized to cancel", 403);
  }

  if (sub.status !== "active") {
    throw new SubscriptionError(
      `Cannot cancel subscription in status: ${sub.status}`,
      400,
    );
  }

  const now = new Date();
  await backendDb
    .update(agentSubscriptions)
    .set({
      status: "cancelled",
      cancelAtPeriodEnd: true,
      cancelledAt: now,
      updatedAt: now,
    })
    .where(eq(agentSubscriptions.subscriptionId, subscriptionId));

  return { subscription_id: subscriptionId, status: "cancelled" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function advancePeriod(from: Date, interval: string): Date {
  const d = new Date(from);
  if (interval === "week") {
    d.setDate(d.getDate() + 7);
  } else if (interval === "month") {
    const origDay = d.getDate();
    d.setMonth(d.getMonth() + 1);
    // Cap at month end if original day exceeds new month's days
    if (d.getDate() < origDay) {
      d.setDate(0); // last day of previous month (which is actually the target month)
    }
  }
  return d;
}

function formatProduct(p: typeof subscriptionProducts.$inferSelect) {
  return {
    product_id: p.productId,
    owner_agent_id: p.ownerAgentId,
    name: p.name,
    description: p.description,
    asset_code: p.assetCode,
    amount_minor: p.amountMinor,
    billing_interval: p.billingInterval,
    status: p.status,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
    archived_at: p.archivedAt?.toISOString() ?? null,
  };
}

function formatSubscription(s: typeof agentSubscriptions.$inferSelect) {
  return {
    subscription_id: s.subscriptionId,
    product_id: s.productId,
    subscriber_agent_id: s.subscriberAgentId,
    provider_agent_id: s.providerAgentId,
    asset_code: s.assetCode,
    amount_minor: s.amountMinor,
    billing_interval: s.billingInterval,
    status: s.status,
    current_period_start: s.currentPeriodStart.toISOString(),
    current_period_end: s.currentPeriodEnd.toISOString(),
    next_charge_at: s.nextChargeAt.toISOString(),
    cancel_at_period_end: s.cancelAtPeriodEnd,
    cancelled_at: s.cancelledAt?.toISOString() ?? null,
    last_charged_at: s.lastChargedAt?.toISOString() ?? null,
    last_charge_tx_id: s.lastChargeTxId,
    consecutive_failed_attempts: s.consecutiveFailedAttempts,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

export class SubscriptionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SubscriptionError";
    this.status = status;
  }
}
