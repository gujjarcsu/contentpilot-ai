// External trigger endpoint — POST /api/generate
// Supports two auth modes (controlled by CONTENTPILOT_AUTH_MODE env var):
//
//   "hmac" (default in production):
//     Caller sends X-Shop-Domain and X-ContentPilot-Signature headers.
//     Signature = HMAC-SHA256(raw request body, shop's Shopify access token).
//     This scopes every request to one shop and rotates automatically when
//     Shopify rotates the shop's offline access token.
//
//   "token" (simple, for Shopify Flow / low-risk integrations):
//     Caller sends X-ContentPilot-Token matching CONTENTPILOT_API_TOKEN.
//     Single global secret — only use when HMAC is not feasible.
//
// Usage from Shopify Flow:
//   HTTP action → POST https://<your-app>/api/generate
//   Headers: X-Shop-Domain: {{shop.domain}}, X-ContentPilot-Signature: <hmac>
//   Body: { "productId": "gid://shopify/Product/123", "contentTypes": ["description"] }

import crypto from "node:crypto";
import prisma from "../db.server";
import { enqueueGenerationJob } from "../queues/generationQueue.server";
import { FREE_PLAN } from "../utils/billing-plans.js";
import logger from "../utils/logger.server";

const AUTH_MODE = process.env.CONTENTPILOT_AUTH_MODE || "hmac";

async function verifyRequest(request, rawBody) {
  if (AUTH_MODE === "token") {
    const token = request.headers.get("X-ContentPilot-Token");
    const expected = process.env.CONTENTPILOT_API_TOKEN;
    if (!expected || token !== expected) return { ok: false };
    // Token mode has no shop-scope — the caller must provide it in the body
    return { ok: true };
  }

  // HMAC mode: per-shop signature verification with replay prevention
  const shopDomain = request.headers.get("X-Shop-Domain");
  const signature = request.headers.get("X-ContentPilot-Signature");
  const tsHeader = request.headers.get("X-ContentPilot-Timestamp");
  if (!shopDomain || !signature || !tsHeader) return { ok: false };

  // Reject requests older than 5 minutes (replay prevention)
  const tsSeconds = parseInt(tsHeader, 10);
  if (isNaN(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    return { ok: false, reason: "timestamp_expired" };
  }

  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    select: { accessToken: true },
  });
  if (!session?.accessToken) return { ok: false };

  // Include timestamp in signed payload so replay with different ts is rejected
  const signedPayload = `${tsHeader}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", session.accessToken)
    .update(signedPayload)
    .digest("hex");

  // Use timingSafeEqual to prevent timing attacks
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return { ok: false };
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return { ok: false };

  return { ok: true, shop: shopDomain };
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const rawBody = await request.text();
  const auth = await verifyRequest(request, rawBody);
  if (!auth.ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { productId, shop: bodyShop, contentTypes: rawTypes, autoPublish = false } = body;

  // In HMAC mode the shop comes from the verified header; in token mode from the body.
  const shop = auth.shop || bodyShop;
  if (!productId || !shop) {
    return Response.json({ error: "productId and shop are required" }, { status: 400 });
  }
  if (productId.length > 200 || shop.length > 200) {
    return Response.json({ error: "Invalid input length" }, { status: 400 });
  }

  const contentTypes = Array.isArray(rawTypes)
    ? rawTypes.filter((t) => ["description", "metaTitle", "metaDescription", "faq"].includes(t))
    : ["description", "metaTitle", "metaDescription"];

  const plan = await prisma.plan.findUnique({ where: { shop } });
  const month = new Date().toISOString().slice(0, 7);
  const usageCount = await prisma.usageRecord.count({ where: { shop, month } });
  const limit = plan?.monthlyLimit ?? FREE_PLAN.monthlyLimit;

  if ((plan?.status ?? "active") !== "active" || usageCount >= limit) {
    return Response.json({ error: "Monthly generation limit reached" }, { status: 429 });
  }

  const gid = productId.startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${productId}`;

  const job = await prisma.generationJob.create({
    data: {
      shop,
      status: "queued",
      totalProducts: 1,
      productIds: JSON.stringify([gid]),
      contentTypes: contentTypes.join(","),
      autoPublish: Boolean(autoPublish),
    },
  });

  logger.info({ shop, jobId: job.id, authMode: AUTH_MODE }, "External generate job queued");
  await enqueueGenerationJob(job.id);
  return Response.json({ success: true, jobId: job.id }, { status: 202 });
};

export const loader = () => Response.json({ error: "Use POST" }, { status: 405 });
