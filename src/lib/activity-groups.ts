/**
 * Repeats on the Activity page (2026-09-29, owner walk-through A1). The same
 * sentence by the same person on the same day, one after another, is one line
 * with a count — "Owner read a document and filled in 58 answers. ×6" — instead
 * of six identical rows. Only consecutive rows fold, so the order of events
 * is never changed. Pure; the list stays newest first.
 */
export type GroupableActivity = { key: string; at: string; when: string; who: string; what: string };
export type ActivityGroup<T extends GroupableActivity> = T & { times: number; earliestWhen: string };

function istDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function groupRepeats<T extends GroupableActivity>(items: T[]): Array<ActivityGroup<T>> {
  const out: Array<ActivityGroup<T>> = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && last.who === item.who && last.what === item.what && istDay(last.at) === istDay(item.at)) {
      last.times += 1;
      last.earliestWhen = item.when;
      continue;
    }
    out.push({ ...item, times: 1, earliestWhen: item.when });
  }
  return out;
}
