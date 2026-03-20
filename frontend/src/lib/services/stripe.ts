import Stripe from "stripe";
import { backendDb } from "@/../db/backend";
import {
  topupRequests,
  walletAccounts,
  walletTransactions,
  walletEntries,
} from "@/../db/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  generateTopupId,
  generateTxId,
  generateWalletEntryId,
} from "@/lib/id-generators";
import { getOrCreateWallet } from "./wallet";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TopupPackageRaw {
  package_code?: string;
  code?: string;
  label?: string;
  coin_amount_minor?: string | number;
  amount_minor?: string | number;
  fiat_amount?: string | number;
  price_cents?: number;
  stripe_price_id?: string;
  currency?: string;
}

interface TopupPackage {
  packageCode: string;
  label: string;
  coinAmountMinor: number;
  fiatAmount: string;
  currency: string;
  priceCents?: number;
  stripePriceId?: string;
}

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(key);
}

function getPackagesRaw(): TopupPackageRaw[] {
  const raw = process.env.STRIPE_TOPUP_PACKAGES;
  if (!raw) return [];
  return JSON.parse(raw) as TopupPackageRaw[];
}

function toMinor(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseInt(value, 10);
  return NaN;
}

function normalizePackage(raw: TopupPackageRaw): TopupPackage | null {
  const packageCode = raw.package_code || raw.code;
  const coinAmountMinor = toMinor(raw.coin_amount_minor ?? raw.amount_minor);
  if (!packageCode || !Number.isFinite(coinAmountMinor)) return null;

  const currency = raw.currency || getCurrency();
  const priceCents = raw.price_cents;
  const fiatAmount =
    raw.fiat_amount != null
      ? String(raw.fiat_amount)
      : typeof priceCents === "number"
        ? (priceCents / 100).toFixed(2)
        : "";

  return {
    packageCode,
    label: raw.label || `${coinAmountMinor} COIN`,
    coinAmountMinor,
    fiatAmount,
    currency,
    priceCents,
    stripePriceId: raw.stripe_price_id,
  };
}

function getPackages(): TopupPackage[] {
  return getPackagesRaw()
    .map(normalizePackage)
    .filter((p): p is TopupPackage => p !== null);
}

function getCurrency(): string {
  return process.env.STRIPE_TOPUP_CURRENCY ?? "usd";
}

function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

// ---------------------------------------------------------------------------
// listPackages
// ---------------------------------------------------------------------------
export function listPackages() {
  return getPackages().map((p) => ({
    package_code: p.packageCode,
    coin_amount_minor: String(p.coinAmountMinor),
    fiat_amount: p.fiatAmount,
    currency: p.currency,
  }));
}

// ---------------------------------------------------------------------------
// createCheckoutSession
// ---------------------------------------------------------------------------
export async function createCheckoutSession(
  agentId: string,
  packageCode: string,
  idempotencyKey?: string,
  quantity: number = 1,
) {
  const packages = getPackages();
  const pkg = packages.find((p) => p.packageCode === packageCode);

  if (!pkg) {
    throw new StripeServiceError("Invalid package code", 400);
  }
  if (!pkg.stripePriceId && typeof pkg.priceCents !== "number") {
    throw new StripeServiceError("Package pricing is not configured", 500);
  }
  if (quantity < 1 || quantity > 100) {
    throw new StripeServiceError("quantity must be between 1 and 100", 400);
  }

  const coinAmountMinor = pkg.coinAmountMinor * quantity;

  await getOrCreateWallet(agentId);

  const stripe = getStripe();
  const topupId = generateTopupId();
  const currency = pkg.currency || getCurrency();
  const appUrl = getAppUrl();

  // Create local topup request
  await backendDb.insert(topupRequests).values({
    topupId,
    agentId,
    assetCode: "COIN",
    amountMinor: coinAmountMinor,
    status: "pending",
    channel: "stripe",
    metadataJson: JSON.stringify({
      package_code: packageCode,
      fiat_amount: pkg.fiatAmount,
      idempotency_key: idempotencyKey,
      quantity,
    }),
  });

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [
        pkg.stripePriceId
          ? { price: pkg.stripePriceId, quantity }
          : {
              price_data: {
                currency,
                product_data: {
                  name: pkg.label,
                  description: `${coinAmountMinor} COIN top-up`,
                },
                unit_amount: pkg.priceCents,
              },
              quantity,
            },
      ],
      metadata: {
        topup_id: topupId,
        agent_id: agentId,
        package_code: packageCode,
        quantity: String(quantity),
        coin_amount_minor: String(coinAmountMinor),
      },
      payment_intent_data: {
        metadata: {
          topup_id: topupId,
          agent_id: agentId,
          package_code: packageCode,
          quantity: String(quantity),
          coin_amount_minor: String(coinAmountMinor),
        },
      },
      success_url: `${appUrl}/chats?wallet_topup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/chats?wallet_topup=cancelled`,
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );

  // Store Stripe session ID as external ref
  await backendDb
    .update(topupRequests)
    .set({ externalRef: session.id })
    .where(eq(topupRequests.topupId, topupId));

  const checkoutUrl = session.url || "";
  const metadata = { package_code: packageCode, checkout_url: checkoutUrl, expires_at: session.expires_at };
  await backendDb
    .update(topupRequests)
    .set({ metadataJson: JSON.stringify(metadata) })
    .where(eq(topupRequests.topupId, topupId));

  return {
    topup_id: topupId,
    tx_id: null,
    checkout_session_id: session.id,
    checkout_url: checkoutUrl,
    expires_at: session.expires_at,
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// getCheckoutStatus
// ---------------------------------------------------------------------------
export async function getCheckoutStatus(sessionId: string, agentId: string) {
  // Find local topup by external ref
  const [topup] = await backendDb
    .select()
    .from(topupRequests)
    .where(
      and(
        eq(topupRequests.externalRef, sessionId),
        eq(topupRequests.agentId, agentId),
      ),
    )
    .limit(1);

  if (!topup) {
    throw new StripeServiceError("Session not found", 404);
  }

  // If already completed, return immediately
  if (topup.status === "completed") {
    return {
      topup_id: topup.topupId,
      tx_id: topup.txId,
      checkout_session_id: sessionId,
      topup_status: "completed",
      payment_status: "paid",
      wallet_credited: true,
      amount_minor: String(topup.amountMinor),
      asset_code: topup.assetCode,
    };
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const paymentStatus = session.payment_status || "unknown";

  if (paymentStatus === "paid" && topup.status === "pending") {
    const result = await fulfillTopup(topup.topupId, agentId, topup.amountMinor);
    return {
      topup_id: topup.topupId,
      tx_id: result.txId,
      checkout_session_id: sessionId,
      topup_status: "completed",
      payment_status: "paid",
      wallet_credited: true,
      amount_minor: String(topup.amountMinor),
      asset_code: topup.assetCode,
    };
  }

  return {
    topup_id: topup.topupId,
    tx_id: topup.txId,
    checkout_session_id: sessionId,
    topup_status: topup.status,
    payment_status: paymentStatus,
    wallet_credited: topup.status === "completed",
    amount_minor: String(topup.amountMinor),
    asset_code: topup.assetCode,
  };
}

// ---------------------------------------------------------------------------
// fulfillTopup (internal)
// ---------------------------------------------------------------------------
async function fulfillTopup(
  topupId: string,
  agentId: string,
  amountMinor: number,
) {
  return await backendDb.transaction(async (tx) => {
    // Re-check status under lock
    const [topup] = await tx
      .select()
      .from(topupRequests)
      .where(eq(topupRequests.topupId, topupId))
      .limit(1);

    if (!topup || topup.status !== "pending") {
      return { txId: topup?.txId ?? null };
    }

    // Lock wallet
    const [wallet] = await tx
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.agentId, agentId),
          eq(walletAccounts.assetCode, "COIN"),
        ),
      )
      .for("update");

    if (!wallet) {
      throw new StripeServiceError("Wallet not found", 404);
    }

    const txId = generateTxId();
    const now = new Date();
    const newBalance = wallet.availableBalanceMinor + amountMinor;

    // Create transaction
    await tx.insert(walletTransactions).values({
      txId,
      type: "topup",
      status: "completed",
      assetCode: "COIN",
      amountMinor,
      feeMinor: 0,
      toAgentId: agentId,
      initiatorAgentId: agentId,
      completedAt: now,
    });

    // Create credit entry
    await tx.insert(walletEntries).values({
      entryId: generateWalletEntryId(),
      txId,
      agentId,
      assetCode: "COIN",
      direction: "credit",
      amountMinor,
      balanceAfterMinor: newBalance,
    });

    // Update wallet balance
    await tx
      .update(walletAccounts)
      .set({
        availableBalanceMinor: newBalance,
        version: sql`${walletAccounts.version} + 1`,
        updatedAt: now,
      })
      .where(eq(walletAccounts.id, wallet.id));

    // Mark topup as completed
    await tx
      .update(topupRequests)
      .set({ status: "completed", txId, completedAt: now })
      .where(eq(topupRequests.topupId, topupId));

    return { txId };
  });
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------
export class StripeServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "StripeServiceError";
    this.status = status;
  }
}
