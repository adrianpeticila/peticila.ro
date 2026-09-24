import { handleWebhookRequest } from "../../../../lib/commerce.js";

export async function onRequest(context) {
  return handleWebhookRequest(context.request, context.env);
}
