import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { ProductSetting, Quote } from "@/lib/types";
import { convertQuoteToOrder } from "@/services/OrderService";

/** Prices and eligibility come from the quote read inside the storage
 * transaction. No standalone claim, partial save or status reset is needed. */
export async function convertPersistedQuoteToOrder(
  workspaceId: string,
  quoteId: string,
  options?: { products?: ProductSetting[] },
  repos: RepositoryBundle = createRepositories(),
) {
  let previousStatus: Quote["status"] | undefined;
  const result = await repos.quote.convertToOrderAtomically(workspaceId, quoteId, quote => {
    previousStatus = quote.status;
    return convertQuoteToOrder(quote, options);
  });
  return result ? { ...result, previousStatus } : undefined;
}
