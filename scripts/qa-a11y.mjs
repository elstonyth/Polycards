// axe-core accessibility scan of key public routes against the running
// standalone storefront (:4000). Fails on serious/critical violations.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { QA_ROUTES } from './qa-routes.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const ROUTES = QA_ROUTES;

// See scripts/qa-color-normalize.mjs: Tailwind v4's oklch neutrals serialize
// with a powerless hue that axe cannot parse, which silently kills the
// color-contrast rule. Injected into every page before the scan.
const NORMALIZER = readFileSync(
  new URL('./qa-color-normalize.mjs', import.meta.url),
  'utf8',
).replace(/^export /m, '');

const browser = await chromium.launch();
// @axe-core/playwright requires a page from an explicit BrowserContext — calling
// browser.newPage() directly makes AxeBuilder.analyze() throw "Please use
// browser.newContext()", which was silently breaking the whole gate.
//
// reducedMotion: 'reduce' — set at the CONTEXT level (applies to every route
// this shared page navigates to, before any load happens) so `Reveal`
// (src/components/Reveal.tsx) renders content at its FINAL opacity/transform
// immediately instead of mid fade-up. Without this, axe can catch a route's
// text at opacity < 1 mid-animation and report a real color as failing
// contrast — plausibly why /about's 1.02–1.63:1 hits all carried
// `transition-delay`/`transition-[opacity,...]` in their failure nodes.
const context = await browser.newContext({ reducedMotion: 'reduce' });
const page = await context.newPage();
let failed = false;

for (const route of ROUTES) {
  // 'load' (not 'networkidle') so the always-animating routes (the reel on
  // /slots, the marquee on /) can't hang the scan; a bounded timeout turns a
  // stuck navigation into a loud failure instead of an indefinite wait.
  let resp;
  try {
    resp = await page.goto(BASE + route, {
      waitUntil: 'load',
      timeout: 30_000,
    });
  } catch (err) {
    failed = true;
    console.error(`\n${route} — navigation failed: ${err.message}`);
    continue;
  }
  // A 404/500 would otherwise let axe scan the (clean) error page and pass.
  if (!resp || !resp.ok()) {
    failed = true;
    console.error(
      `\n${route} — bad response: ${resp ? resp.status() : 'none'}`,
    );
    continue;
  }

  await page.addScriptTag({ content: NORMALIZER });
  await page.evaluate(() => window.__qaNormalizeColors());

  const { violations, passes, incomplete } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  // A rule that ABORTS reports neither passes nor violations, so "no violations"
  // is not the same as "checked and clean" — that is exactly how the oklch parse
  // failure hid every contrast breach behind a green gate. Treat a rule that
  // produced no result at all as a failure, not a pass.
  const evaluated = (id) =>
    passes.some((r) => r.id === id) || violations.some((r) => r.id === id);
  const DEALBREAKERS = ['color-contrast'];
  for (const id of DEALBREAKERS) {
    if (!evaluated(id)) {
      failed = true;
      const why = incomplete.find((r) => r.id === id);
      console.error(
        `\n${route} — RULE DID NOT RUN: ${id}` +
          (why ? ` (incomplete: ${why.nodes.length} node(s))` : ''),
      );
    }
  }

  const serious = violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  if (serious.length) {
    failed = true;
    console.error(`\n${route} — ${serious.length} serious/critical:`);
    for (const v of serious) {
      console.error(`  [${v.impact}] ${v.id}: ${v.help}`);
      // The rule name alone sent the last reader hunting for selectors by hand.
      for (const n of v.nodes.slice(0, 8)) {
        const ratio = (n.failureSummary ?? '').match(
          /contrast of ([\d.]+)/,
        )?.[1];
        console.error(
          `      ${ratio ? `${ratio}:1 ` : ''}${n.html.replace(/\s+/g, ' ').slice(0, 100)}`,
        );
      }
      if (v.nodes.length > 8)
        console.error(`      … +${v.nodes.length - 8} more`);
    }
  } else {
    console.log(`OK ${route}`);
  }
}
await browser.close();
if (failed) process.exit(1);
console.log('\nNo serious/critical a11y violations.');
