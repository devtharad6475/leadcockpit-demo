/** Security override regression: real DOCX extraction and shipped CLI, no AI/DB/data mutations. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import mammoth from 'mammoth';
const require = createRequire(import.meta.url);

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-mammoth-proof-'));
  try {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sample product catalogue</w:t></w:r></w:p><w:p><w:r><w:t>PF7 — नमूना &amp; specifications</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Material</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Polypropylene</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const fixture = path.join(dir, 'catalogue.docx');
    await fs.writeFile(fixture, buffer);
    const extracted = await mammoth.extractRawText({ buffer });
    assert.equal(extracted.value, 'Sample product catalogue\n\nPF7 — नमूना & specifications\n\nMaterial\n\nPolypropylene\n\n');
    assert.deepEqual(extracted.messages, []);
    const cli = require.resolve('mammoth/bin/mammoth');
    const mammothRequire = createRequire(require.resolve('mammoth'));
    assert.equal(mammothRequire('argparse/package.json').version, '2.0.1');
    const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
    {
      const html = run([fixture]);
      assert.equal(html.status, 0, html.stderr);
      assert.equal(html.stdout, '<p>Sample product catalogue</p><p>PF7 — नमूना &amp; specifications</p><table><tr><td><p>Material</p></td><td><p>Polypropylene</p></td></tr></table>');
      const markdown = run([fixture, '--output-format', 'markdown']);
      assert.equal(markdown.status, 0, markdown.stderr);
      assert.equal(markdown.stdout, 'Sample product catalogue\n\nPF7 — नमूना & specifications\n\nMaterial\n\nPolypropylene\n\n');
      const outfile = path.join(dir, 'output.html');
      const output = run([fixture, outfile]);
      assert.equal(output.status, 0, output.stderr);
      assert.equal(await fs.readFile(outfile, 'utf8'), html.stdout);
      const outdir = path.join(dir, 'output-directory');
      await fs.mkdir(outdir);
      const directory = run([fixture, '--output-dir', outdir]);
      assert.equal(directory.status, 0, directory.stderr);
      assert.equal(await fs.readFile(path.join(outdir, 'catalogue.html'), 'utf8'), html.stdout);
      const styles = path.join(dir, 'styles.txt');
      await fs.writeFile(styles, 'p => section:fresh');
      const styled = run([fixture, '--style-map', styles]);
      assert.equal(styled.status, 0, styled.stderr);
      assert.match(styled.stdout, /^<section>Sample product catalogue<\/section>/);
      const help = run(['--help']);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /--output-format/);
      assert.match(help.stdout, /docx-path/);
      const conflict = run([fixture, outfile, '--output-dir', outdir]);
      assert.equal(conflict.status, 2, conflict.stderr);
      assert.match(conflict.stderr, /not allowed with argument/);
      const invalid = run([fixture, '--output-format', 'invalid']);
      assert.equal(invalid.status, 2, invalid.stderr);
      assert.match(invalid.stderr, /invalid choice/);
      console.log('PASS real mammoth CLI: exact HTML/Markdown/file/directory, style map, help, rejects conflicting output and invalid choice');
    }
    console.log('PASS actual extractRawText DOCX paragraphs, Hindi, XML escaping, table cells with exact expected value');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

