import {
  handleCatalogRequest,
  handleBuyRequest,
  handleWebhookRequest
} from "./lib/commerce.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/catalog.json" || url.pathname === "/api/catalog") {
      return handleCatalogRequest(request, env);
    }

    if (url.pathname === "/api/agent/buy") {
      return handleBuyRequest(request, env);
    }

    if (url.pathname === "/api/agent/payments/webhook") {
      return handleWebhookRequest(request, env);
    }

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};
