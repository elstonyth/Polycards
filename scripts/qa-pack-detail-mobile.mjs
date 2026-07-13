// QA: pack detail mobile-first layout (stage → buy panel → card sections).
// Usage: node scripts/qa-pack-detail-mobile.mjs [baseUrl]
// Screenshots to docs/research/, plus JSON measurements to stdout.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const SLUGS = ['pikachu', 'elite-pack'];
mkdirSync('docs/research', { recursive: true });

const browser = await chromium.launch();
try {
  for (const slug of SLUGS) {
    for (const [label, viewport] of [
      ['mobile', { width: 390, height: 844 }],
      ['desktop', { width: 1440, height: 900 }],
    ]) {
      const page = await browser.newPage({ viewport });
      const res = await page.goto(`${BASE}/slots/${slug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      if (!res || res.status() !== 200) {
        console.log(JSON.stringify({ slug, label, skipped: res?.status() }));
        await page.close();
        continue;
      }
      // Wait for a concrete readiness signal instead of network quiescence —
      // this page polls recent pulls (~4s) + prices (~60s), so networkidle never settles.
      await page
        .waitForSelector(
          'button:has-text("Open Pack"), button:has-text("Log in to open")',
          {
            timeout: 15000,
          },
        )
        .catch(() => {});
      const m = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          /Open Pack|Log in to open/.test(b.textContent ?? ''),
        );
        const stage = document.querySelector('main img[alt]');
        const pool = [...document.querySelectorAll('h2')].find((h) =>
          h.textContent?.includes('Cards in this pack'),
        );
        const rect = (el) =>
          el ? Math.round(el.getBoundingClientRect().top + scrollY) : null;
        return {
          buyButtonTop: rect(btn),
          stageTop: rect(stage),
          poolTop: rect(pool),
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
        };
      });
      console.log(JSON.stringify({ slug, label, ...m }));
      await page.screenshot({
        path: `docs/research/qa-pack-detail-${slug}-${label}.png`,
        fullPage: false,
      });
      await page.screenshot({
        path: `docs/research/qa-pack-detail-${slug}-${label}-full.png`,
        fullPage: true,
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
