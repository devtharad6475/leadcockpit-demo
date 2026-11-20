/** Keep JSON destination reads from overlapping atomic replacement on Windows.
 * This queue coordinates only file IO, independently of business transactions.
 * Callbacks must not recursively acquire it; parsing/business logic stays outside.
 */
let pending: Promise<void> = Promise.resolve();
export function withJsonFileIO<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  // A failed read/write must release subsequent operations, not poison the queue.
  pending = result.then(() => undefined, () => undefined);
  return result;
}
