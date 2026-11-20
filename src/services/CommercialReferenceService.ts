import type { RepositoryBundle } from "@/repositories/interfaces";
import { NeedsActionError } from "@/lib/user-errors";

/** A conversation link on an order must refer to its own customer and company. */
export async function validateOrderReplyLink(
  workspaceId: string, leadId: string, replyId: string | undefined, repos: RepositoryBundle,
): Promise<string | undefined> {
  const id = replyId?.trim();
  if (!id) return undefined;
  const reply = await repos.reply.getById(workspaceId, id);
  if (!reply) throw new NeedsActionError("The linked customer message was not found in your workspace.", 404);
  if (!leadId || reply.leadId !== leadId) throw new NeedsActionError("Choose the customer who owns this message before linking it to an order.", 400);
  return id;
}
