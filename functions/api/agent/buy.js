import { handleBuyRequest } from "../../../lib/commerce.js";

export async function onRequest(context) {
  return handleBuyRequest(context.request, context.env);
}
