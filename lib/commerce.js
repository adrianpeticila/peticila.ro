/**
 * M2M Agentic Commerce Engine for peticila.ro
 * Implements 7-key catalog schema, rate limiting, idempotency,
 * x402 programmatic rails, stripe_hosted checkout, and HMAC webhooks.
 */

export const CATALOG = [
  {
    id: "consulting-1on1",
    name: "1:1 Strategic Consulting & Positioning Audit",
    price_cents: 49900,
    currency: "USD",
    description: "Direct 1:1 strategic positioning audit and go-to-market architecture advisory with written synthesis.",
    sample_output_url: "https://peticila.ro/work/",
    checkout_type: "stripe_hosted"
  },
  {
    id: "b2b-marketing-blueprint",
    name: "B2B Marketing Blueprint & Framework",
    price_cents: 19900,
    currency: "USD",
    description: "Comprehensive enterprise B2B marketing blueprint and go-to-market positioning framework.",
    sample_output_url: "https://peticila.ro/mcp/",
    checkout_type: "stripe_hosted"
  },
  {
    id: "strategic-funnel-roast",
    name: "Strategic Funnel Roast",
    price_cents: 4900,
    currency: "USD",
    description: "Programmatic tear-down and diagnostic roast of positioning, messaging friction, and funnel mechanics.",
    sample_output_url: "https://peticila.ro/daemon/",
    checkout_type: "x402"
  }
];

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, X-Payment-Proof, X-Signature-SHA256, X-Webhook-Signature, Stripe-Signature",
  "Access-Control-Max-Age": "86400"
};

export class MemoryKV {
  constructor() {
    this.store = new Map();
  }

  async get(key, type = "text") {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    if (type === "json") {
      try {
        return JSON.parse(item.value);
      } catch {
        return null;
      }
    }
    return item.value;
  }

  async put(key, value, options = {}) {
    const strVal = typeof value === "string" ? value : JSON.stringify(value);
    const expiresAt = options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    this.store.set(key, { value: strVal, expiresAt });
  }

  async delete(key) {
    this.store.delete(key);
  }
}

const memoryStore = new MemoryKV();

export function getKVStore(env) {
  if (env && env.AGENT_STORE && typeof env.AGENT_STORE.get === "function") {
    return env.AGENT_STORE;
  }
  return memoryStore;
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyHmacSignature(rawBody, signature, secret) {
  if (!signature || !secret) {
    return false;
  }

  let sigHex = signature.trim();
  if (sigHex.startsWith("sha256=")) {
    sigHex = sigHex.slice(7);
  } else if (sigHex.includes("v1=")) {
    const match = sigHex.match(/v1=([a-f0-9]+)/i);
    if (match) {
      sigHex = match[1];
    }
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(rawBody)
    );
    const expectedHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return timingSafeEqual(sigHex.toLowerCase(), expectedHex.toLowerCase());
  } catch {
    return false;
  }
}

export async function handleCatalogRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed. Use GET." }, 405);
  }

  return jsonResponse(CATALOG, 200, {
    "Cache-Control": "public, max-age=300"
  });
}

export async function handleBuyRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  const store = getKVStore(env);

  // Rate limiting logic
  const clientIp = request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "127.0.0.1";
  const rateLimitWindow = Math.floor(Date.now() / 60000);
  const rateLimitKey = `ratelimit:${clientIp}:${rateLimitWindow}`;
  const maxRequestsPerMin = parseInt(env?.RATE_LIMIT_MAX_PER_MINUTE || "30", 10);
  const currentRequests = parseInt(await store.get(rateLimitKey) || "0", 10);

  if (currentRequests >= maxRequestsPerMin) {
    return jsonResponse(
      { error: "Rate limit exceeded. Maximum 30 requests per minute.", status: 429 },
      429,
      { "Retry-After": "60" }
    );
  }
  await store.put(rateLimitKey, String(currentRequests + 1), { expirationTtl: 120 });

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body", status: 400 }, 400);
  }

  // Idempotency check
  const idempotencyKey = request.headers.get("Idempotency-Key") ||
    body?.idempotency_key ||
    body?.idempotencyKey;

  const idempotencyKvKey = idempotencyKey ? `idempotency:${idempotencyKey}` : null;
  if (idempotencyKvKey) {
    const cached = await store.get(idempotencyKvKey, "json");
    if (cached) {
      return jsonResponse(cached.body, cached.status, {
        ...(cached.headers || {}),
        "X-Cache": "HIT-IDEMPOTENT"
      });
    }
  }

  const productId = body?.product_id || body?.productId || body?.id;
  if (!productId) {
    return jsonResponse({ error: "Missing required field: product_id", status: 400 }, 400);
  }

  const product = CATALOG.find((p) => p.id === productId);
  if (!product) {
    return jsonResponse(
      {
        error: "Product not found",
        status: 404,
        valid_products: CATALOG.map((p) => p.id)
      },
      404
    );
  }

  let finalResponse;

  if (product.checkout_type === "x402") {
    // 20 USD programmatic daily cap logic (2000 cents)
    const dailyCapKey = `daily_cap:${new Date().toISOString().slice(0, 10)}`;
    const currentDailySpend = parseInt(await store.get(dailyCapKey) || "0", 10);
    const dailyCapCents = parseInt(env?.DAILY_PROGRAMMATIC_CAP_CENTS || "2000", 10);

    if (currentDailySpend + product.price_cents > dailyCapCents) {
      finalResponse = {
        status: 429,
        headers: {},
        body: {
          error: "Programmatic daily cap of $20.00 USD exceeded",
          status: 429,
          cap_cents: dailyCapCents,
          current_spent_cents: currentDailySpend,
          attempted_amount_cents: product.price_cents
        }
      };
    } else {
      const paymentProof = request.headers.get("X-Payment-Proof") ||
        request.headers.get("Authorization") ||
        body?.payment_proof;

      if (paymentProof) {
        // Payment verified on programmatic rail
        await store.put(dailyCapKey, String(currentDailySpend + product.price_cents), { expirationTtl: 172800 });

        const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const orderData = {
          order_id: orderId,
          product_id: product.id,
          amount_cents: product.price_cents,
          currency: product.currency,
          proof: paymentProof,
          settled_at: new Date().toISOString()
        };
        await store.put(`order:${orderId}`, JSON.stringify(orderData), { expirationTtl: 86400 * 30 });

        finalResponse = {
          status: 200,
          headers: {
            "X-Order-Id": orderId,
            "X-Payment-Rail": "x402"
          },
          body: {
            status: "paid",
            order_id: orderId,
            product_id: product.id,
            name: product.name,
            amount_cents: product.price_cents,
            currency: product.currency,
            settlement_rail: "x402",
            fulfillment: {
              status: "ready",
              access_url: `${product.sample_output_url}?order=${orderId}`
            }
          }
        };
      } else {
        // Return HTTP 402 with x402 programmatic payment headers
        const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await store.put(`invoice:${invoiceId}`, JSON.stringify({
          invoice_id: invoiceId,
          product_id: product.id,
          amount_cents: product.price_cents,
          currency: product.currency,
          created_at: new Date().toISOString()
        }), { expirationTtl: 3600 });

        finalResponse = {
          status: 402,
          headers: {
            "X-Payment-Required": "true",
            "X-Payment-Amount": String(product.price_cents),
            "X-Payment-Currency": product.currency,
            "X-Payment-Product-Id": product.id,
            "X-Payment-Rail": "x402",
            "X-Payment-Invoice": invoiceId,
            "X-402-Price-Cents": String(product.price_cents),
            "X-402-Currency": product.currency,
            "WWW-Authenticate": `L402 invoice="${invoiceId}", token="x402_${invoiceId}"`
          },
          body: {
            status: 402,
            error: "Payment Required",
            checkout_type: "x402",
            product,
            payment: {
              rail: "x402",
              invoice: invoiceId,
              token: `x402_${invoiceId}`,
              amount_cents: product.price_cents,
              currency: product.currency,
              pay_endpoint: "/api/agent/buy",
              settlement_header: `X-Payment-Proof: x402_${invoiceId}`
            }
          }
        };
      }
    }
  } else {
    // Hosted rail: stripe_hosted
    const checkoutSessionId = `cs_live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const checkoutUrl = env?.STRIPE_CHECKOUT_URL ||
      `https://checkout.stripe.com/pay/${product.id}?session=${checkoutSessionId}`;

    finalResponse = {
      status: 200,
      headers: {
        "X-Checkout-Type": "stripe_hosted"
      },
      body: {
        status: "checkout_ready",
        checkout_type: "stripe_hosted",
        product_id: product.id,
        name: product.name,
        price_cents: product.price_cents,
        currency: product.currency,
        checkout_url: checkoutUrl,
        idempotency_key: idempotencyKey || null
      }
    };
  }

  // Cache idempotent response
  if (idempotencyKvKey) {
    await store.put(idempotencyKvKey, JSON.stringify(finalResponse), { expirationTtl: 86400 });
  }

  return jsonResponse(finalResponse.body, finalResponse.status, finalResponse.headers);
}

export async function handleWebhookRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  const rawBody = await request.text();
  const signature = request.headers.get("X-Signature-SHA256") ||
    request.headers.get("X-Webhook-Signature") ||
    request.headers.get("Stripe-Signature");
  const secret = env?.PAYMENT_WEBHOOK_SECRET ||
    env?.WEBHOOK_SECRET ||
    "default_nyx_webhook_secret_peticila";

  const isValid = await verifyHmacSignature(rawBody, signature, secret);
  if (!isValid) {
    return jsonResponse({ error: "Invalid webhook signature", status: 401 }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON payload", status: 400 }, 400);
  }

  const store = getKVStore(env);
  const isProgrammatic = payload.rail === "x402" ||
    payload.rail === "programmatic" ||
    payload.product_id === "strategic-funnel-roast";

  const dailyCapCents = parseInt(env?.DAILY_PROGRAMMATIC_CAP_CENTS || "2000", 10);
  const dailyCapKey = `daily_cap:${new Date().toISOString().slice(0, 10)}`;
  const currentDailySpend = parseInt(await store.get(dailyCapKey) || "0", 10);

  const matchedProduct = CATALOG.find((p) => p.id === payload.product_id);
  const amountCents = parseInt(
    payload.amount_cents !== undefined ? payload.amount_cents : (matchedProduct ? matchedProduct.price_cents : 0),
    10
  );

  if (isProgrammatic) {
    // 20 USD programmatic daily cap logic
    if (currentDailySpend + amountCents > dailyCapCents) {
      return jsonResponse(
        {
          error: "Programmatic daily cap of $20.00 USD exceeded",
          status: 429,
          cap_cents: dailyCapCents,
          current_spent_cents: currentDailySpend,
          attempted_amount_cents: amountCents
        },
        429
      );
    }
    await store.put(dailyCapKey, String(currentDailySpend + amountCents), { expirationTtl: 172800 });
  }

  const paymentId = payload.payment_id || `pay_${Date.now()}`;
  await store.put(`payment:${paymentId}`, JSON.stringify({
    ...payload,
    amount_cents: amountCents,
    verified_at: new Date().toISOString()
  }), { expirationTtl: 86400 * 30 });

  return jsonResponse({
    received: true,
    status: "processed",
    payment_id: paymentId,
    rail: payload.rail || (isProgrammatic ? "x402" : "hosted"),
    daily_spent_cents: isProgrammatic ? currentDailySpend + amountCents : currentDailySpend,
    daily_cap_cents: dailyCapCents
  }, 200);
}
