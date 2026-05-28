import { Prisma } from "@prisma/client";
import prisma from "../db.server.js";
import { BILLING_PLANS, FREE_PLAN } from "./billing-plans.js";
import { getCache, setCache, invalidateCache } from "./cache.server.js";

export { FREE_PLAN };

// Map Shopify billing plan key → our internal plan definition
export function getPlanByKey(shopifyKey) {
  return Object.values(BILLING_PLANS).find((p) => p.key === shopifyKey) ?? null;
}

export async function getOrCreatePlan(shop) {
  const existing = await prisma.plan.findUnique({ where: { shop } });
  if (existing) return existing;
  return prisma.plan.create({
    data: {
      shop,
      planName: FREE_PLAN.planName,
      status: "active",
      monthlyLimit: FREE_PLAN.monthlyLimit,
    },
  });
}

export async function getMonthlyUsageCount(shop) {
  const month = new Date().toISOString().slice(0, 7);
  return prisma.usageRecord.count({ where: { shop, month } });
}

/**
 * Read-only gate: returns current plan state and usage.
 * Use tryConsumeGeneration() for the actual gate check + atomic write.
 * Result is cached for 60 s to reduce DB load on page loads.
 */
export async function canGenerate(shop) {
  const month = new Date().toISOString().slice(0, 7);
  const cacheKey = `canGenerate:${shop}:${month}`;
  return getCache(cacheKey, async () => {
    const [plan, usageCount] = await Promise.all([
      getOrCreatePlan(shop),
      getMonthlyUsageCount(shop),
    ]);
    const allowed = plan.status === "active" && usageCount < plan.monthlyLimit;
    return {
      allowed,
      usageCount,
      monthlyLimit: plan.monthlyLimit,
      planName: plan.planName,
      remaining: Math.max(0, plan.monthlyLimit - usageCount),
    };
  }, 60);
}

/**
 * Atomic gate + usage record creation in one serializable transaction.
 *
 * Uses SERIALIZABLE isolation so two concurrent requests cannot both
 * pass the limit check before either writes the usage record.
 * In SQLite this is a no-op (single writer already serializes everything).
 * In PostgreSQL this prevents phantom reads.
 *
 * Returns { allowed, planName, monthlyLimit, remaining } — if allowed is
 * true, the UsageRecord has already been written inside the transaction.
 * The caller must NOT write another UsageRecord for the same generation.
 */
export async function tryConsumeGeneration(shop, contentType, productId = null) {
  const month = new Date().toISOString().slice(0, 7);

  // Free re-generation: if this product was already generated in the last 24h,
  // don't count it against the monthly limit — encourage iteration on quality.
  if (productId) {
    const recentGeneration = await prisma.usageRecord.findFirst({
      where: {
        shop,
        productId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (recentGeneration) {
      return { allowed: true, isFreeRegeneration: true, planName: "free", monthlyLimit: 0, remaining: 0 };
    }
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const plan = await tx.plan.findUnique({ where: { shop } });
        if (!plan || plan.status !== "active") {
          return {
            allowed: false,
            planName: plan?.planName ?? "free",
            monthlyLimit: plan?.monthlyLimit ?? FREE_PLAN.monthlyLimit,
            remaining: 0,
          };
        }

        const usageCount = await tx.usageRecord.count({ where: { shop, month } });

        if (usageCount >= plan.monthlyLimit) {
          return {
            allowed: false,
            planName: plan.planName,
            monthlyLimit: plan.monthlyLimit,
            remaining: 0,
          };
        }

        // Write the record atomically — inside the transaction this is the
        // only writer for this shop in this transaction, preventing double-spend.
        await tx.usageRecord.create({
          data: { shop, month, contentType, productId, tokensUsed: 0 },
        });

        return {
          allowed: true,
          planName: plan.planName,
          monthlyLimit: plan.monthlyLimit,
          remaining: plan.monthlyLimit - usageCount - 1,
        };
      },
      {
        // Prevents phantom reads across concurrent transactions in PostgreSQL.
        // SQLite ignores this option (it's always serializable due to write lock).
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10_000,
      }
    );
    if (result.allowed) {
      await invalidateCache(`canGenerate:${shop}:${month}`);
    }
    return result;
  } catch (err) {
    // P2034 = "Transaction failed due to a write conflict or a deadlock"
    // This can happen under very high concurrent load with Serializable isolation.
    // Treat it as rate-limited to be safe.
    if (err.code === "P2034") {
      return { allowed: false, planName: "unknown", monthlyLimit: 0, remaining: 0 };
    }
    throw err;
  }
}

/**
 * Sync the active Shopify subscription into our Plan table.
 * Called from Plans page loader and subscription webhook.
 */
export async function syncBillingToPlan(shop, appSubscriptions) {
  const activeSub = (appSubscriptions ?? []).find((s) => s.status === "ACTIVE");

  if (activeSub) {
    const planDef = getPlanByKey(activeSub.name);
    if (planDef) {
      await prisma.plan.upsert({
        where: { shop },
        update: {
          planName: planDef.planName,
          status: "active",
          monthlyLimit: planDef.monthlyLimit,
          shopifyChargeId: activeSub.id,
          currentPeriodEnd: activeSub.currentPeriodEnd
            ? new Date(activeSub.currentPeriodEnd)
            : null,
        },
        create: {
          shop,
          planName: planDef.planName,
          status: "active",
          monthlyLimit: planDef.monthlyLimit,
          shopifyChargeId: activeSub.id,
          currentPeriodEnd: activeSub.currentPeriodEnd
            ? new Date(activeSub.currentPeriodEnd)
            : null,
        },
      });
      await invalidateCache(`plan:${shop}`);
      return;
    }
  }

  // No active paid subscription → downgrade to free
  await prisma.plan.upsert({
    where: { shop },
    update: {
      planName: FREE_PLAN.planName,
      status: "active",
      monthlyLimit: FREE_PLAN.monthlyLimit,
      shopifyChargeId: null,
      currentPeriodEnd: null,
    },
    create: {
      shop,
      planName: FREE_PLAN.planName,
      status: "active",
      monthlyLimit: FREE_PLAN.monthlyLimit,
    },
  });
  await invalidateCache(`plan:${shop}`);
}
