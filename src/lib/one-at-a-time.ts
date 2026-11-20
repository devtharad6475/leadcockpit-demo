/**
 * Run work for the same key one after another instead of at the same time.
 *
 * For "check, then create" steps where two requests arriving together would
 * both pass the check (break test, 2026-09-26: five "New conversation" clicks
 * made five empty chats). This holds within one server process, which is how
 * the app runs today; a database constraint is the answer if it ever runs as
 * several processes.
 */
const tails = new Map<string, Promise<unknown>>();

export async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(work);
  tails.set(key, run);
  try {
    return await run;
  } finally {
    if (tails.get(key) === run) tails.delete(key);
  }
}
