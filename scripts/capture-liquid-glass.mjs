// One-off capture of the liquid-glass surfaces against the worktree dev server.
import { chromium } from 'playwright';

// PW_BASE matches the repo's e2e convention; the old hardcoded value was an
// ephemeral worktree dev port.
const BASE = process.env.PW_BASE ?? 'http://localhost:3000';
const OUT = process.argv[2] ?? '.';
const browser = await chromium.launch();

// Desktop: scrolled home (frosted header) + auth modal (refraction panel).
const desktop = await browser.newPage({
  viewport: { width: 1280, height: 800 },
});
await desktop.goto(BASE, { waitUntil: 'networkidle' });
await desktop.evaluate(() => window.scrollTo(0, 700));
await desktop.waitForTimeout(400);
await desktop.screenshot({ path: `${OUT}/desktop-header-frost.png` });
await desktop.evaluate(() =>
  window.dispatchEvent(
    new CustomEvent('polycards:auth', { detail: { mode: 'login' } }),
  ),
);
await desktop.waitForTimeout(600);
await desktop.screenshot({ path: `${OUT}/desktop-auth-glass.png` });

// Mobile: TabBar frost + cookie banner.
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto(BASE, { waitUntil: 'networkidle' });
await mobile.evaluate(() => window.scrollTo(0, 500));
await mobile.waitForTimeout(400);
await mobile.screenshot({ path: `${OUT}/mobile-tabbar-frost.png` });

await browser.close();
console.log('done');
