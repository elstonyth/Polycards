// Diagnose modern-grails soft edge: zoom the LEFT plate region, original over current.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const orig =
  'data:image/webp;base64,' +
  (
    await readFile(
      'docs/research/packdetail/lama-in/modern-grails-noafw0.png',
    ).catch(() =>
      readFile('docs/research/packdetail/lama-in/modern-grails-noafw0.png'),
    )
  ).toString('base64');
const cur =
  'data:image/webp;base64,' +
  (
    await readFile('public/images/claw/modern-grails-noafw0-machine.webp')
  ).toString('base64');
// lama-in is PNG; fix mime
const origPng =
  'data:image/png;base64,' +
  (
    await readFile('docs/research/packdetail/lama-in/modern-grails-noafw0.png')
  ).toString('base64');

// source 1037x720. Left plate region ~ x 0.27-0.56, y 0.05-0.21. Zoom to 1400px wide.
const SX = 0.27,
  EX = 0.56,
  SY = 0.05,
  EY = 0.21,
  OW = 1037,
  OH = 720;
const dispW = 1400;
const scale = dispW / ((EX - SX) * OW);
const cropH = Math.round((EY - SY) * OH * scale);
const cell = (
  src,
  label,
) => `<div style="font:12px monospace;color:#fff">${label}</div>
  <div style="width:${dispW}px;height:${cropH}px;overflow:hidden;background:#222;margin-bottom:8px">
    <img src="${src}" style="width:${Math.round(OW * scale)}px;margin-left:-${Math.round(SX * OW * scale)}px;margin-top:-${Math.round(SY * OH * scale)}px"/></div>`;
const html = `<!doctype html><body style="margin:0;background:#555;padding:8px">${cell(origPng, 'ORIGINAL (phygitals)')}${cell(cur, 'CURRENT (pokenic)')}</body>`;
const f = resolve('docs/research/packdetail/_diagmg.html').replace(/\\/g, '/');
writeFileSync(f, html);
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: dispW + 30, height: cropH * 2 + 80 },
  deviceScaleFactor: 1.3,
});
await page.goto('file:///' + f, { waitUntil: 'load' });
await page.waitForTimeout(400);
await page.screenshot({
  path: 'docs/research/packdetail/diag_mg.png',
  fullPage: true,
});
await browser.close();
console.log('done');
