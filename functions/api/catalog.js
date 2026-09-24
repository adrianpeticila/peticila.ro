import { handleCatalogRequest } from "../../lib/commerce.js";

export async function onRequest(context) {
  return handleCatalogRequest(context.request, context.env);
}
