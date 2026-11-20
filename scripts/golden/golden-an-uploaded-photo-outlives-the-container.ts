/**
 * golden-an-uploaded-photo-outlives-the-container.ts — session 55 (2026-09-10).
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts. This is a
 * PERSISTENCE golden: it needs `.env`'s DATABASE_URL and a real Postgres.
 *
 * THE DEFECT THIS EXISTS TO STOP COMING BACK
 * ------------------------------------------
 * Uploaded media was written to `<cwd>/public/uploads/...` and the row kept
 * `/uploads/<folder>/<name>` as its URL. On a laptop that works forever. On the
 * substrate this product is deployed on it is a lie with no error message:
 *
 *   * the container has no persistent disk, so every deploy AND every idle
 *     spin-down replaced the filesystem. The row survived. The file did not.
 *     The catalogue screen went on listing the item, and its image 404'd.
 *
 *   * a WhatsApp media send does not upload bytes — it hands Meta a LINK and
 *     Meta fetches it from this origin. So the catalogue photo the AI chose to
 *     attach was fetched from a URL with nothing behind it. The customer got
 *     no photo, and the operator got no failure to look at.
 *
 * Nothing in the product could catch this, because the two things that break it
 * are "time passes" and "a deploy happens".
 *
 * HAND-COMPUTED CONTRACT (written before running it):
 *
 *   CASE A — the column exists. Asked of `information_schema`, not of Prisma: a
 *     client generated from a schema whose migration was never applied will
 *     happily describe a column the database does not have.
 *
 *   CASE B — an upload is addressed by an API URL, never by a /uploads path.
 *     The URL is the whole defect: as long as a row can point at a container
 *     path, the row outlives what it points at.
 *
 *   CASE C — the bytes come back, byte for byte, through a SECOND repository
 *     bundle built after the write. Same-object memory would pass a weaker
 *     test; only the store can answer this one. This is the "survives a
 *     restart" assertion, expressed the only way a single process can express
 *     it honestly.
 *
 *   CASE D — nothing lands under public/uploads. If a byte still goes there,
 *     the old failure is still one deploy away, whatever the URL says.
 *
 *   CASE E — a list response does not carry the file. A 12 MB upload is 16 MB
 *     of base64; if that rides inside the catalogue list, the screen that shows
 *     six products ships tens of megabytes and file bytes start appearing in
 *     logs. The bytes must be reachable ONLY one item at a time.
 *
 *   CASE F — the file route sits ABOVE the production auth gate in the route
 *     file. Meta fetches the link with no cookies. Behind the gate, every
 *     photo the AI attaches fails to send in production and works in demo,
 *     which is the worst possible place for that difference to hide.
 *
 *   CASE G — the relative URL becomes an absolute one for Meta. A link Meta
 *     cannot resolve is the same outage as a link with nothing behind it.
 *
 *   CASE H — archiving an item takes the bytes with it. Otherwise the most
 *     expensive half of a deleted row stays in the database forever, and a
 *     "deleted" photo is still served to anyone holding its id.
 *
 * ISOLATION (Gate #8): a RUN-tagged workspace, cascade-deleted in `finally`.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-prisma-provider.ts scripts/golden/golden-an-uploaded-photo-outlives-the-container.ts
 */
import assert from "node:assert";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { absoluteMediaUrl } from "@/providers/whatsapp/MetaWhatsAppCloudProvider";
import {
  deleteMediaCatalogItem,
  listMediaCatalogItems,
  readMediaCatalogFile,
  saveMediaCatalogItem,
} from "@/services/MediaCatalogService";
import type { MediaCatalogItem } from "@/lib/types";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_media_${RUN}`;

const repos = createRepositories("prisma");

// A small but genuinely binary payload: high bytes and a NUL, so a substrate
// that quietly round-trips through a string would corrupt it and be caught.
const FILE_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ...Array.from({ length: 512 }, (_, i) => (i * 7) % 256),
  0xff, 0xd9,
]);

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

let item: MediaCatalogItem;
let uploadsBefore: string[] = [];

async function listPublicUploads(): Promise<string[]> {
  const root = path.join(process.cwd(), "public", "uploads");
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // the directory not existing at all is the healthiest outcome
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

async function seed() {
  await repos.workspace.create({
    id: WS, name: `Media golden ${RUN}`, status: "active",
    autonomyKillSwitch: false, autoSendToggle: false,
  });
  uploadsBefore = await listPublicUploads();
  item = await saveMediaCatalogItem({
    workspaceId: WS,
    fileName: "neem-zari-thread-r.jpg",
    fileType: "image/jpeg",
    buffer: FILE_BYTES,
    category: "product_image",
    title: "Neem Zari Thread R",
    caption: "Rs. 335 / Kg, ex-works Surat",
  }, repos);
}

// ─── CASE A ─────────────────────────────────────────────────────────────────
test("CASE A — the bytes column exists in the database", async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'media_catalog_items' AND column_name = 'content_base64'`,
  );
  assert.strictEqual(rows.length, 1,
    "media_catalog_items.content_base64 does not exist. Uploads have nowhere durable to live, " +
    "so every catalogue photo is one deploy away from being a 404 the operator cannot see.");
});

// ─── CASE B ─────────────────────────────────────────────────────────────────
test("CASE B — an upload is addressed by an API URL, not a container path", async () => {
  assert.strictEqual(item.url, `/api/media/${item.id}/file`,
    `the stored URL is ${JSON.stringify(item.url)}. A /uploads/... URL points at a filesystem ` +
    "that is replaced on every deploy, while the row that names it survives.");
  assert.strictEqual(item.storagePath, "",
    `storagePath is ${JSON.stringify(item.storagePath)} — a path no process will ever open is ` +
    "worse than an empty one, because it reads like the file is somewhere.");
  assert.strictEqual(item.fileSize, FILE_BYTES.length, "the recorded size is not the file's size");
});

// ─── CASE C ─────────────────────────────────────────────────────────────────
test("CASE C — the bytes come back byte-for-byte through a fresh repository", async () => {
  // A bundle built AFTER the write: nothing in this call can be served from the
  // object that did the writing. This is the closest a single process gets to
  // "the container was replaced".
  const fresh = createRepositories("prisma");
  const stored = await readMediaCatalogFile(WS, item.id, fresh);
  assert.ok(stored, "the file could not be read back at all — the upload did not persist");
  assert.strictEqual(stored!.bytes.length, FILE_BYTES.length,
    `read back ${stored!.bytes.length} bytes, stored ${FILE_BYTES.length}`);
  assert.ok(stored!.bytes.equals(FILE_BYTES),
    "the bytes came back changed. A corrupted image is not a smaller failure than a missing " +
    "one — the customer receives a broken file either way.");
  assert.strictEqual(stored!.item.fileType, "image/jpeg",
    "the content type is not stored, so the file would be served as something the client cannot render");
});

// ─── CASE D ─────────────────────────────────────────────────────────────────
test("CASE D — nothing was written under public/uploads", async () => {
  const after = await listPublicUploads();
  const added = after.filter((file) => !uploadsBefore.includes(file));
  assert.deepStrictEqual(added, [],
    `the upload still wrote ${added.length} file(s) into public/uploads (${added.join(", ")}). ` +
    "That directory does not survive a deploy, so the old failure is still one deploy away.");
});

// ─── CASE E ─────────────────────────────────────────────────────────────────
test("CASE E — a catalogue listing does not carry the file bytes", async () => {
  const list = await listMediaCatalogItems(WS, repos);
  const mine = list.find((row) => row.id === item.id);
  assert.ok(mine, "the uploaded item is not in the catalogue listing");
  const serialised = JSON.stringify(list);
  assert.ok(!serialised.includes("contentBase64"),
    "the list response carries a contentBase64 field. A 12 MB upload is 16 MB of base64 in " +
    "every catalogue render, and file bytes start turning up in logs.");
  assert.ok(!serialised.includes(FILE_BYTES.toString("base64").slice(0, 40)),
    "the file's own bytes are inside the list response under some other name");
});

// ─── CASE F ─────────────────────────────────────────────────────────────────
test("CASE F — the file route is reachable without a session", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(process.cwd(), "src", "app", "api", "[[...path]]", "route.ts"), "utf8");
  const routeAt = source.indexOf(`match(path, ["media", ":id", "file"])`);
  assert.ok(routeAt > 0, "there is no GET route serving a stored media file");
  const gateAt = source.indexOf(`if (getAuthMode() === "production" && !productionAuthConfigured())`);
  assert.ok(gateAt > 0, "the production auth gate could not be found — this assertion cannot be trusted");
  assert.ok(routeAt < gateAt,
    "the media file route sits BELOW the production auth gate. Meta fetches the link with no " +
    "cookies, so every photo the AI attaches would send fine in demo and fail in production.");
});

// ─── CASE G ─────────────────────────────────────────────────────────────────
test("CASE G — the relative URL becomes an absolute one for Meta", async () => {
  const absolute = absoluteMediaUrl(item.url, "https://lead-cockpit-demo.onrender.com");
  assert.strictEqual(absolute, `https://lead-cockpit-demo.onrender.com/api/media/${item.id}/file`,
    `Meta would be handed ${JSON.stringify(absolute)}, which it cannot fetch.`);
  const alreadyAbsolute = absoluteMediaUrl("https://cdn.example.com/a.jpg", "https://other.example.com");
  assert.strictEqual(alreadyAbsolute, "https://cdn.example.com/a.jpg",
    "an already-absolute URL must be left alone, or a hosted asset gets a second origin glued on");
});

// ─── CASE H ─────────────────────────────────────────────────────────────────
test("CASE H — archiving an item takes its bytes with it", async () => {
  const doomed = await saveMediaCatalogItem({
    workspaceId: WS,
    fileName: "withdrawn-shade.jpg",
    fileType: "image/jpeg",
    buffer: FILE_BYTES,
    category: "product_image",
  }, repos);
  await deleteMediaCatalogItem(WS, doomed.id, "user_golden", repos);

  const stored = await readMediaCatalogFile(WS, doomed.id, repos);
  assert.strictEqual(stored, undefined,
    "a withdrawn photo is still served to anyone holding its id, and its bytes still cost " +
    "database space forever.");
});

(async () => {
  console.log("=== GOLDEN: an uploaded photo outlives the container ===\n");
  let passed = 0;
  let failed = 0;
  try {
    await seed();
    for (const c of cases) {
      try {
        await c.fn();
        passed++;
        console.log(`  PASS  ${c.name}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL  ${c.name}`);
        console.error(`        ${(e as Error).message}`);
      }
    }
  } finally {
    try {
      await prisma.workspace.deleteMany({ where: { id: WS } });
    } catch { /* best-effort */ }
  }

  console.log("");
  console.log(`=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("golden-an-uploaded-photo-outlives-the-container FAILED — uploaded media does not survive a deploy.");
    process.exit(1);
  }
  console.log("golden-an-uploaded-photo-outlives-the-container ALL GREEN");
  process.exit(0);
})();
