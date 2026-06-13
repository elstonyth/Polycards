// Render all downloaded *-machine.{avif,webp} into one labeled contact sheet via a
// file:// HTML page (same-origin, so local images load) — confirms each is the
// claw-machine render, not a stray gallery image.
import { chromium } from 'playwright';
import { readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIR = 'public/images/claw';
const files = await readdir(DIR);
const bases = [
  ...new Set(
    files
      .filter((f) => /-machine\.(avif|webp)$/.test(f))
      .map((f) => f.replace(/-machine\.(avif|webp)$/, '')),
  ),
].sort();

// HTML lives in docs/research/packdetail/ → images are ../../../public/images/claw/
const cells = bases
  .map((b) => {
    const avif = files.includes(`${b}-machine.avif`);
    const src = `../../../public/images/claw/${b}-machine.${avif ? 'avif' : 'webp'}`;
    return `<div style="width:240px"><div style="font:12px monospace;color:#fff;margin-bottom:4px">${b} ${avif ? '[avif]' : '[webp]'}</div><img src="${src}" style="width:240px;height:150px;object-fit:contain;background:#222;border:1px solid #444"/></div>`;
  })
  .join('');
const html = `<!doctype html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap;gap:10px;padding:12px">${cells}</body>`;

const htmlPath = 'docs/research/packdetail/machines.html';
await writeFile(htmlPath, html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
await page.goto('file:///' + resolve(htmlPath).replace(/\\/g, '/'), {
  waitUntil: 'load',
});
await page.waitForTimeout(2500);
await page.screenshot({
  path: 'docs/research/packdetail/machines-grid.png',
  fullPage: true,
});
await browser.close();
console.log(`rendered ${bases.length} machines`);
