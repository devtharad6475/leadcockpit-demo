/**
 * Make the Postgres demo demonstrable again, WITHOUT re-seeding it (N-OBS-2).
 *
 * WHY THIS EXISTS
 * ---------------
 * `demo:check` can now tell you the truth about the substrate the product
 * actually serves from (S16-7). On 2026-08-24 the truth was: the Postgres demo
 * was 163.9 hours old, every WhatsApp 24-hour window shut, so it demonstrated
 * the template-only path instead of the free-text reply path.
 *
 * The obvious fix does not exist. `seed:demo` rewrites the JSON file and never
 * touches Postgres. `seed:demo:prisma` REFUSES, correctly, because the demo rows
 * in this database were migrated in from JSON and are not its own `seed_*` rows;
 * its `--force` prints "Expect a unique-constraint failure if an order number
 * collides" and would leave the database half-written. Neither command can make
 * this demo fresh, so telling an operator to run one is advice that gets
 * followed and does not work.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The demo does not need new rows. It needs the SAME conversation, moved
 * forward on the clock. So: find the newest inbound WhatsApp reply, compute one
 * single delta that lands it `--minutes-ago` before now, and add that same delta
 * to every conversation timestamp in the demo workspace. One delta for
 * everything means relative order is preserved exactly — a reply that came two
 * hours after an outreach message still does.
 *
 * `lastInboundAt` is then DERIVED from the moved replies through
 * `lastInboundByLead`, never hand-set. Hand-typed copies of a derived value are
 * precisely what drifts (N-DATA-9).
 *
 * SAFETY
 * ------
 * It refuses to touch any workspace but `workspace_demo`. It refuses to move
 * time BACKWARDS, so it can never be used to reopen a window that a real
 * customer's silence has closed. It refuses to rewrite a demo that is already
 * demonstrable with room to spare, because re-stamping a conversation that did
 * not need it is a silent edit of history for no gain. **It does nothing at all
 * without --apply.** Nothing is deleted, and no row is created.
 *
 * Run: npm run demo:refresh:prisma -- --apply
 */
import { prisma } from "../src/lib/prisma";
import { lastInboundByLead } from "../src/lib/last-inbound";
import { DEMO_MIN_WINDOW_MINUTES } from "../src/lib/demo-freshness";
import { WHATSAPP_WINDOW_MS } from "../src/lib/whatsapp-window";

const DEMO_WORKSPACE = "workspace_demo";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const minutesAgo = Number(argValue("--minutes-ago") ?? "5");
  if (!Number.isFinite(minutesAgo) || minutesAgo < 0) {
    console.error(`--minutes-ago must be a non-negative number, got: ${argValue("--minutes-ago")}`);
    process.exit(1);
  }

  const replies = await prisma.reply.findMany({
    where: { workspaceId: DEMO_WORKSPACE },
    select: { id: true, leadId: true, channel: true, createdAt: true },
  });

  if (replies.length === 0) {
    console.error(`No replies in ${DEMO_WORKSPACE}. There is no conversation to move forward.`);
    console.error("This script moves an existing demo on the clock; it does not create one.");
    process.exit(1);
  }

  const whatsapp = replies.filter((r) => r.channel.trim().toLowerCase() === "whatsapp");
  if (whatsapp.length === 0) {
    console.error(`No WhatsApp replies in ${DEMO_WORKSPACE}. Only WhatsApp opens the 24-hour window,`);
    console.error("so moving email replies forward would not make this demo demonstrable.");
    process.exit(1);
  }

  const newest = whatsapp.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const target = Date.now() - minutesAgo * 60_000;
  const deltaMs = target - newest.createdAt.getTime();

  console.log(`workspace:        ${DEMO_WORKSPACE}`);
  console.log(`replies:          ${replies.length} (${whatsapp.length} on WhatsApp)`);
  console.log(`newest inbound:   ${newest.createdAt.toISOString()} (${(( Date.now() - newest.createdAt.getTime()) / 3_600_000).toFixed(1)}h ago)`);
  console.log(`window length:    ${WHATSAPP_WINDOW_MS / 3_600_000}h`);
  console.log(`shift:            +${(deltaMs / 3_600_000).toFixed(1)}h, applied identically to every timestamp`);

  if (deltaMs <= 0) {
    console.log("\nAlready at or ahead of the target. Refusing to move time BACKWARDS —");
    console.log("that would reopen a window the product had correctly closed. Nothing changed.");
    process.exit(0);
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to move the demo forward.");
    process.exit(0);
  }

  // Already fine? Then leave the conversation alone. Running this on a healthy
  // demo would shuffle every timestamp forward by a few minutes and change
  // nothing an operator could see - an edit with no purpose is still an edit,
  // and the point of this script is to make a STALE demo usable.
  const minutesLeft = Math.floor((newest.createdAt.getTime() + WHATSAPP_WINDOW_MS - Date.now()) / 60_000);
  if (minutesLeft >= DEMO_MIN_WINDOW_MINUTES && !process.argv.includes("--force")) {
    console.log("");
    console.log(minutesLeft + " minutes left on the newest window and the threshold is " + DEMO_MIN_WINDOW_MINUTES + ".");
    console.log("Already demonstrable. Nothing changed. Pass --force to move it anyway.");
    process.exit(0);
  }

  const shift = (d: Date) => new Date(d.getTime() + deltaMs);

  const interactions = await prisma.interaction.findMany({
    where: { workspaceId: DEMO_WORKSPACE },
    select: { id: true, timestamp: true, createdAt: true },
  });
  const outreach = await prisma.outreachActivity.findMany({
    where: { workspaceId: DEMO_WORKSPACE },
    select: { id: true, activityAt: true, createdAt: true },
  });

  await prisma.$transaction([
    ...replies.map((r) =>
      prisma.reply.update({ where: { id: r.id }, data: { createdAt: shift(r.createdAt) } }),
    ),
    ...interactions.map((i) =>
      prisma.interaction.update({
        where: { id: i.id },
        data: { timestamp: shift(i.timestamp), createdAt: shift(i.createdAt) },
      }),
    ),
    ...outreach.map((o) =>
      prisma.outreachActivity.update({
        where: { id: o.id },
        data: { activityAt: shift(o.activityAt), createdAt: shift(o.createdAt) },
      }),
    ),
  ]);

  // Derived, not hand-set (N-DATA-9).
  const moved = await prisma.reply.findMany({
    where: { workspaceId: DEMO_WORKSPACE },
    select: { leadId: true, channel: true, createdAt: true },
  });
  const derived = lastInboundByLead(
    moved.map((r) => ({ leadId: r.leadId, channel: r.channel, createdAt: r.createdAt.toISOString() })),
  );

  let updatedLeads = 0;
  for (const [leadId, at] of derived) {
    await prisma.lead.update({ where: { id: leadId }, data: { lastInboundAt: new Date(at) } });
    updatedLeads += 1;
  }

  console.log(`\nMoved:            ${replies.length} replies, ${interactions.length} interactions, ${outreach.length} outreach activities`);
  console.log(`lastInboundAt:    re-derived for ${updatedLeads} lead(s) — never hand-set`);
  console.log("\nNow run: npm run demo:check");
}

main()
  .catch((error) => {
    console.error("refresh failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
