/**
 * Break test, part 6 (2026-09-26): documents as real people upload them —
 * empty, damaged, mislabelled, the wrong kind. Sent through the real
 * "read this file" endpoint on the throwaway server (port 3020). Anything
 * other than a readable answer (a 5xx, a hang, or a crash) is a failure.
 *
 *   BREAK_BASE_URL=http://127.0.0.1:3020 npx tsx scripts/probes/break-uploads.ts
 */
const BASE = process.env.BREAK_BASE_URL || "http://127.0.0.1:3020";

const files: Array<[string, string, Uint8Array | string, string]> = [
  ["an empty text file", "empty.txt", "", "text/plain"],
  ["an empty PDF (0 bytes)", "empty.pdf", new Uint8Array(0), "application/pdf"],
  ["a damaged PDF", "broken.pdf", "%PDF-1.7\n1 0 obj << /Type /Catalog >>\nthis is not really a pdf", "application/pdf"],
  ["a photo renamed to .pdf", "photo.pdf", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]), "application/pdf"],
  ["a damaged Word file", "broken.docx", "PK\u0003\u0004 not a real zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["an old .doc Word file", "old.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "application/msword"],
  ["an Excel file", "prices.xlsx", "PK\u0003\u0004 xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["a file with no extension", "README", "Zari thread, 5 kg minimum.", "application/octet-stream"],
  ["text in Hindi and Gujarati", "hindi.txt", "न्यूनतम ऑर्डर 5 किलो। ન્યૂનતમ ઓર્ડર 5 કિલો.", "text/plain"],
  ["a text file that is really binary", "fake.txt", new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 256)), "text/plain"],
  ["a broken JSON file", "data.json", "{\"price\": ", "application/json"],
  ["a file name with odd characters", "../../etc/passwd<script>.txt", "MOQ 5 kg", "text/plain"],
];

(async () => {
  let failed = 0;
  for (const [label, name, content, type] of files) {
    const form = new FormData();
    form.append("files", new Blob([content as BlobPart], { type }), name);
    const started = Date.now();
    let status = 0;
    let text = "";
    try {
      const response = await fetch(`${BASE}/api/documents/extract-file-text`, { method: "POST", headers: { origin: BASE }, body: form, signal: AbortSignal.timeout(60000) });
      status = response.status;
      text = (await response.text()).slice(0, 180).replace(/\s+/g, " ");
    } catch (error) {
      text = `NO ANSWER: ${(error as Error).message}`;
    }
    const bad = status === 0 || status >= 500 || /something went wrong on our side/i.test(text);
    if (bad) failed++;
    console.log(`${bad ? "FAIL" : "OK  "} ${label} → ${status} (${Date.now() - started} ms) ${text}`);
  }
  console.log(`\n${failed ? `${failed} FAILED` : "ALL OK"}`);
})().catch((error) => { console.error(error); process.exit(1); });

export {};
