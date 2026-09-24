/**
 * Test Suite for M2M Agentic Commerce Engine on peticila.ro
 * Tests: 7-key catalog schema, rate limiting, idempotency,
 * x402 headers, stripe_hosted rail, HMAC webhook, and $20 daily cap.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CATALOG,
  MemoryKV,
  handleCatalogRequest,
  handleBuyRequest,
  handleWebhookRequest,
  verifyHmacSignature
} from "../lib/commerce.js";

async function createHmacSignature(rawBody, secret) {
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
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function runTests() {
  console.log("Running M2M Agentic Commerce test suite...\n");
  let passed = 0;
  let failed = 0;

  function record(testName, fn) {
    return async () => {
      try {
        await fn();
        console.log(`[PASS] ${testName}`);
        passed++;
      } catch (err) {
        console.error(`[FAIL] ${testName}:`, err);
        failed++;
      }
    };
  }

  // 1. Catalog schema test
  await record("1. Catalog matches exact 7-key schema contract", async () => {
    assert.equal(CATALOG.length, 3, "Catalog must contain exactly 3 products");
    const requiredKeys = [
      "checkout_type",
      "currency",
      "description",
      "id",
      "name",
      "price_cents",
      "sample_output_url"
    ];

    for (const item of CATALOG) {
      const keys = Object.keys(item).sort();
      assert.deepEqual(keys, requiredKeys, `Product ${item.id} must have exact 7 keys`);
      assert.equal(item.currency, "USD", "Currency must be USD");
      assert.equal(typeof item.price_cents, "number", "price_cents must be number");
      assert.ok(item.sample_output_url.startsWith("https://"), "sample_output_url must be https");
    }

    const p1 = CATALOG.find((p) => p.id === "consulting-1on1");
    assert.ok(p1, "consulting-1on1 must exist");
    assert.equal(p1.price_cents, 49900, "Price must be 49900 cents ($499)");
    assert.equal(p1.checkout_type, "stripe_hosted");

    const p2 = CATALOG.find((p) => p.id === "b2b-marketing-blueprint");
    assert.ok(p2, "b2b-marketing-blueprint must exist");
    assert.equal(p2.price_cents, 19900, "Price must be 19900 cents ($199)");
    assert.equal(p2.checkout_type, "stripe_hosted");

    const p3 = CATALOG.find((p) => p.id === "strategic-funnel-roast");
    assert.ok(p3, "strategic-funnel-roast must exist");
    assert.equal(p3.price_cents, 4900, "Price must be 4900 cents ($49)");
    assert.equal(p3.checkout_type, "x402");
  })();

  // 2. Static catalog.json matches CATALOG export
  await record("2. static api/catalog.json matches CATALOG array", async () => {
    const raw = fs.readFileSync(path.resolve("./api/catalog.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, CATALOG, "Static catalog must match exported CATALOG array");
  })();

  // 3. handleCatalogRequest endpoint
  await record("3. GET /api/catalog.json returns 200 with JSON catalog", async () => {
    const req = new Request("https://peticila.ro/api/catalog.json", { method: "GET" });
    const res = await handleCatalogRequest(req, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/json");
    const data = await res.json();
    assert.equal(data.length, 3);
  })();

  await record("4. OPTIONS /api/catalog.json returns 204 with CORS", async () => {
    const req = new Request("https://peticila.ro/api/catalog.json", { method: "OPTIONS" });
    const res = await handleCatalogRequest(req, {});
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  })();

  // 4. Rate limiting on buy endpoint
  await record("5. /api/agent/buy rate limiting triggers 429 when exceeded", async () => {
    const ip = "192.0.2.42";
    const env = { RATE_LIMIT_MAX_PER_MINUTE: "2" };

    // Request 1
    const r1 = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ product_id: "consulting-1on1" })
    });
    const res1 = await handleBuyRequest(r1, env);
    assert.equal(res1.status, 200);

    // Request 2
    const r2 = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ product_id: "consulting-1on1" })
    });
    const res2 = await handleBuyRequest(r2, env);
    assert.equal(res2.status, 200);

    // Request 3 should be rate limited
    const r3 = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ product_id: "consulting-1on1" })
    });
    const res3 = await handleBuyRequest(r3, env);
    assert.equal(res3.status, 429, "Third request must return 429");
    assert.equal(res3.headers.get("Retry-After"), "60");
  })();

  // 5. Idempotency test
  await record("6. /api/agent/buy returns cached idempotent response", async () => {
    const env = { RATE_LIMIT_MAX_PER_MINUTE: "100" };
    const idemKey = `idem-test-${Date.now()}`;

    const r1 = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey,
        "CF-Connecting-IP": "10.0.0.1"
      },
      body: JSON.stringify({ product_id: "consulting-1on1" })
    });
    const res1 = await handleBuyRequest(r1, env);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.status, "checkout_ready");
    assert.ok(data1.checkout_url);

    // Second request with same idempotency key
    const r2 = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey,
        "CF-Connecting-IP": "10.0.0.1"
      },
      body: JSON.stringify({ product_id: "consulting-1on1" })
    });
    const res2 = await handleBuyRequest(r2, env);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("X-Cache"), "HIT-IDEMPOTENT");
    const data2 = await res2.json();
    assert.equal(data2.checkout_url, data1.checkout_url);
  })();

  // 6. stripe_hosted rail
  await record("7. stripe_hosted rail returns 200 and checkout_url", async () => {
    const env = { RATE_LIMIT_MAX_PER_MINUTE: "100" };
    const req = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.2" },
      body: JSON.stringify({ product_id: "b2b-marketing-blueprint" })
    });
    const res = await handleBuyRequest(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "checkout_ready");
    assert.equal(data.checkout_type, "stripe_hosted");
    assert.equal(data.product_id, "b2b-marketing-blueprint");
    assert.equal(data.price_cents, 19900);
    assert.ok(data.checkout_url.includes("stripe.com"));
  })();

  // 7. x402 programmatic rail without proof
  await record("8. x402 programmatic rail returns HTTP 402 with required headers", async () => {
    // Override daily cap to allow $49 attempt for header verification
    const env = {
      RATE_LIMIT_MAX_PER_MINUTE: "100",
      DAILY_PROGRAMMATIC_CAP_CENTS: "10000"
    };
    const req = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.3" },
      body: JSON.stringify({ product_id: "strategic-funnel-roast" })
    });
    const res = await handleBuyRequest(req, env);
    assert.equal(res.status, 402, "Must return HTTP 402 Payment Required");

    // Verify payment headers
    assert.equal(res.headers.get("X-Payment-Required"), "true");
    assert.equal(res.headers.get("X-Payment-Amount"), "4900");
    assert.equal(res.headers.get("X-Payment-Currency"), "USD");
    assert.equal(res.headers.get("X-Payment-Product-Id"), "strategic-funnel-roast");
    assert.equal(res.headers.get("X-Payment-Rail"), "x402");
    assert.ok(res.headers.get("X-Payment-Invoice").startsWith("inv_"));
    assert.equal(res.headers.get("X-402-Price-Cents"), "4900");
    assert.equal(res.headers.get("X-402-Currency"), "USD");
    assert.ok(res.headers.get("WWW-Authenticate").startsWith("L402 invoice="));

    const body = await res.json();
    assert.equal(body.status, 402);
    assert.equal(body.checkout_type, "x402");
    assert.equal(body.payment.amount_cents, 4900);
  })();

  // 8. x402 programmatic rail with proof
  await record("9. x402 programmatic rail with proof returns HTTP 200 and access_url", async () => {
    const env = {
      AGENT_STORE: new MemoryKV(),
      RATE_LIMIT_MAX_PER_MINUTE: "100",
      DAILY_PROGRAMMATIC_CAP_CENTS: "10000"
    };
    const req = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "10.0.0.4",
        "X-Payment-Proof": "x402_test_settlement_token"
      },
      body: JSON.stringify({ product_id: "strategic-funnel-roast" })
    });
    const res = await handleBuyRequest(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "paid");
    assert.ok(body.order_id.startsWith("ord_"));
    assert.equal(body.settlement_rail, "x402");
    assert.ok(body.fulfillment.access_url.includes("peticila.ro/daemon/?order="));
  })();

  // 9. Webhook signature verification
  await record("10. Webhook rejects invalid HMAC signature with 401", async () => {
    const secret = "test_webhook_secret_key_12345";
    const payload = JSON.stringify({
      event: "payment.succeeded",
      payment_id: "pay_101",
      product_id: "consulting-1on1",
      amount_cents: 49900,
      rail: "stripe"
    });

    const req = new Request("https://peticila.ro/api/agent/payments/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-SHA256": "bad_hex_signature"
      },
      body: payload
    });

    const res = await handleWebhookRequest(req, { WEBHOOK_SECRET: secret });
    assert.equal(res.status, 401, "Invalid signature must return 401");
  })();

  await record("11. Webhook accepts valid HMAC signature with 200", async () => {
    const secret = "test_webhook_secret_key_12345";
    const payload = JSON.stringify({
      event: "payment.succeeded",
      payment_id: "pay_102",
      product_id: "consulting-1on1",
      amount_cents: 49900,
      rail: "stripe"
    });

    const validSig = await createHmacSignature(payload, secret);
    const req = new Request("https://peticila.ro/api/agent/payments/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-SHA256": validSig
      },
      body: payload
    });

    const res = await handleWebhookRequest(req, { WEBHOOK_SECRET: secret });
    assert.equal(res.status, 200, "Valid signature must return 200");
    const body = await res.json();
    assert.equal(body.status, "processed");
    assert.equal(body.payment_id, "pay_102");
  })();

  // 10. $20 Programmatic daily cap logic
  await record("12. $20 programmatic daily cap prevents exceeding $20.00 USD limit", async () => {
    const secret = "test_webhook_secret_key_12345";
    const env = {
      AGENT_STORE: new MemoryKV(),
      WEBHOOK_SECRET: secret,
      DAILY_PROGRAMMATIC_CAP_CENTS: "2000" // $20.00 USD = 2000 cents
    };

    // First programmatic payment of $15 (1500 cents) should succeed
    const payload1 = JSON.stringify({
      event: "payment.succeeded",
      payment_id: `pay_prog_${Date.now()}_1`,
      product_id: "strategic-funnel-roast",
      amount_cents: 1500,
      rail: "x402"
    });
    const sig1 = await createHmacSignature(payload1, secret);
    const req1 = new Request("https://peticila.ro/api/agent/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": sig1 },
      body: payload1
    });
    const res1 = await handleWebhookRequest(req1, env);
    assert.equal(res1.status, 200, "First $15 payment within $20 cap must succeed");

    // Second programmatic payment of $10 (1000 cents) would push daily spend to $25 -> must fail with 429
    const payload2 = JSON.stringify({
      event: "payment.succeeded",
      payment_id: `pay_prog_${Date.now()}_2`,
      product_id: "strategic-funnel-roast",
      amount_cents: 1000,
      rail: "x402"
    });
    const sig2 = await createHmacSignature(payload2, secret);
    const req2 = new Request("https://peticila.ro/api/agent/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-SHA256": sig2 },
      body: payload2
    });
    const res2 = await handleWebhookRequest(req2, env);
    assert.equal(res2.status, 429, "Second payment exceeding $20 cap must return 429");
    const body2 = await res2.json();
    assert.ok(body2.error.includes("daily cap of $20.00 USD exceeded"));
  })();

  // 11. Worker router fetch tests
  await record("13. worker.js routes catalog, buy, and webhook properly", async () => {
    const worker = (await import("../worker.js")).default;

    // Route /api/catalog
    const req1 = new Request("https://peticila.ro/api/catalog", { method: "GET" });
    const res1 = await worker.fetch(req1, {});
    assert.equal(res1.status, 200);

    // Route /api/catalog.json
    const req2 = new Request("https://peticila.ro/api/catalog.json", { method: "GET" });
    const res2 = await worker.fetch(req2, {});
    assert.equal(res2.status, 200);

    // Route /api/agent/buy
    const req3 = new Request("https://peticila.ro/api/agent/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "consulting-1on1" })
    });
    const res3 = await worker.fetch(req3, {});
    assert.equal(res3.status, 200);

    // Route /api/agent/payments/webhook without sig -> 401
    const req4 = new Request("https://peticila.ro/api/agent/payments/webhook", {
      method: "POST",
      body: "{}"
    });
    const res4 = await worker.fetch(req4, {});
    assert.equal(res4.status, 401);

    // Unmatched path without ASSETS -> 404
    const req5 = new Request("https://peticila.ro/unknown-path", { method: "GET" });
    const res5 = await worker.fetch(req5, {});
    assert.equal(res5.status, 404);
  })();

  // 12. Zero em-dashes across all repo files
  await record("14. Zero em-dashes in all created code and catalog files", async () => {
    const filesToCheck = [
      "./api/catalog.json",
      "./public/api/catalog.json",
      "./lib/commerce.js",
      "./worker.js",
      "./_worker.js",
      "./functions/api/catalog.json.js",
      "./functions/api/catalog.js",
      "./functions/api/agent/buy.js",
      "./functions/api/agent/payments/webhook.js",
      "./tests/commerce.test.js"
    ];

    for (const file of filesToCheck) {
      const fullPath = path.resolve(file);
      const content = fs.readFileSync(fullPath, "utf8");
      for (let i = 0; i < content.length; i++) {
        const code = content.charCodeAt(i);
        if (code === 8211 || code === 8212) {
          throw new Error(`Em-dash or en-dash detected in ${file} at char ${i}`);
        }
      }
    }
  })();

  console.log(`\n========================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
