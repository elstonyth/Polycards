// Recon the LIVE phygitals pack-opening experience (to ground the clone's
// pack-opening animation). Screenshots the home, /claw, and a pack-detail; tries
// to reach the open flow. Notes whether the real opening is gated by login.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "docs/design-references/phygitals-open";
mkdirSync(OUT, { recursive: true });
const BASE = "https://www.phygitals.com";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const log = [];

async function shot(name, url, waitMs = 3500) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(waitMs);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    const title = await page.title().catch(() => "");
    const url2 = page.url();
    const bodyLen = (await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0));
    log.push({ name, requested: url, landed: url2, title: title.slice(0, 60), bodyLen, redirected: !url2.startsWith(url) });
    return true;
  } catch (e) {
    log.push({ name, requested: url, error: String(e).slice(0, 120) });
    return false;
  }
}

await shot("01-home", `${BASE}/`);
await shot("02-claw", `${BASE}/claw`);
// Try a known pack-detail slug shape (the clone mirrors phygitals slugs).
await shot("03-claw-detail", `${BASE}/claw/pokemon-mythic`);
await shot("04-pack-party", `${BASE}/pack-party`);

// On the claw page, look for an "open"/"play"/credit CTA and whether it gates.
await page.goto(`${BASE}/claw`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
const ctas = await page.evaluate(() => {
  const t = (document.body?.innerText || "").toLowerCase();
  const has = (s) => t.includes(s);
  const buttons = [...document.querySelectorAll("button,a")]
    .map((b) => (b.innerText || "").trim())
    .filter((x) => x && x.length < 40 && /open|play|claw|login|sign|connect|credit|rip|reveal/i.test(x))
    .slice(0, 25);
  return { mentionsLogin: has("log in") || has("login") || has("sign in") || has("connect wallet"), buttons: [...new Set(buttons)] };
}).catch((e) => ({ error: String(e).slice(0, 100) }));
log.push({ claw_ctas: ctas });

await browser.close();
console.log(JSON.stringify(log, null, 2));
