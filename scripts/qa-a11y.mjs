// axe-core accessibility scan of key public routes against the running
// standalone storefront (:4000). Fails on serious/critical violations.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { QA_ROUTES } from './qa-routes.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const ROUTES = QA_ROUTES;
const ARTIFACTS = new URL('../tests/e2e/.artifacts/a11y/', import.meta.url);
mkdirSync(ARTIFACTS, { recursive: true });

// See scripts/qa-color-normalize.mjs: Tailwind v4's oklch neutrals serialize
// with a powerless hue that axe cannot parse, which silently kills the
// color-contrast rule. The read-time adapter also covers DOM updates during
// the scan. Injected into every page before axe reads computed styles.
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
const manualReviews = [];

for (const route of ROUTES) {
  let routeFailed = false;
  let routeIncomplete = false;
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

  // Reveal and HowItWorksSteps start transparent until hydration reads the
  // reduced-motion preference. `load` and Playwright visibility can both pass
  // before that happens. Check the rendered heading and both existing reveal
  // patterns, including ancestors, so axe cannot pass on chrome/footer alone.
  try {
    await page.waitForFunction(
      () => {
        const main = document.querySelector('main');
        // Ranks deliberately has an sr-only h1; its visible section heading
        // provides the rendered-content signal instead.
        const heading = main?.querySelector(
          'h1:not(.sr-only), h2:not(.sr-only), h3:not(.sr-only)',
        );
        if (!heading?.textContent.trim()) return false;
        const rendered = (element) => {
          if (!element.getClientRects().length) return false;
          for (
            let ancestor = element;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            const style = getComputedStyle(ancestor);
            if (
              Number(style.opacity) === 0 ||
              style.display === 'none' ||
              style.visibility !== 'visible' ||
              style.contentVisibility === 'hidden'
            )
              return false;
          }
          return true;
        };
        const reveals = main.querySelectorAll(
          '[style*="transition-delay"], [style*="translateY("], ' +
            '.opacity-0.translate-y-6, .opacity-100.translate-y-0',
        );
        return (
          rendered(heading) &&
          [...reveals].every(
            (element) =>
              // Reduced motion disables interpolation. Preserve deliberate final
              // opacity-70 logos, while requiring hidden reveal markers to clear.
              !element.classList.contains('opacity-0') &&
              !element.classList.contains('translate-y-6') &&
              !element.style.transform.startsWith('translateY(') &&
              rendered(element),
          )
        );
      },
      null,
      { timeout: 10_000 },
    );
  } catch (err) {
    failed = true;
    console.error(`\n${route} — content not ready for a11y: ${err.message}`);
    continue;
  }

  await page.addScriptTag({ content: NORMALIZER });
  await page.evaluate(() => window.__qaNormalizeColors());

  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const { violations, passes, incomplete } = result;
  const artifactName =
    route === '/' ? 'home' : route.slice(1).replace(/[^a-zA-Z0-9_-]/g, '_');
  writeFileSync(
    new URL(`${artifactName}.json`, ARTIFACTS),
    JSON.stringify(result, null, 2),
  );

  // A rule that ABORTS reports neither passes nor violations, so "no violations"
  // is not the same as "checked and clean" — that is exactly how the oklch parse
  // failure hid every contrast breach behind a green gate. Treat a rule that
  // produced no result at all as a failure, not a pass.
  const evaluated = (id) =>
    passes.some((r) => r.id === id) || violations.some((r) => r.id === id);
  const DEALBREAKERS = ['color-contrast'];
  for (const id of DEALBREAKERS) {
    const why = incomplete.find((r) => r.id === id);
    const executionFailed =
      Boolean(why?.error) ||
      why?.nodes.some((node) =>
        [...node.any, ...node.all, ...node.none].some(
          (check) =>
            check.id === 'error-occurred' ||
            check.data?.messageKey === 'colorParse' ||
            Boolean(check.data?.colorParse),
        ),
      );
    if (!evaluated(id) || why) {
      routeIncomplete = true;
      if (!evaluated(id) || executionFailed) {
        failed = true;
        routeFailed = true;
      } else {
        // Gradients/overlaps have always needed manual contrast review. Keep
        // that policy, while making the unmeasured nodes explicit. Parser or
        // execution errors are never a manual-review escape hatch.
        manualReviews.push({ route, nodes: why.nodes.length });
      }
      const status = !evaluated(id)
        ? 'RULE DID NOT RUN'
        : executionFailed
          ? 'RULE INCOMPLETE'
          : 'MANUAL REVIEW';
      console.error(
        `\n${route} — ${status}: ${id}` +
          (why ? ` (incomplete: ${why.nodes.length} node(s))` : ''),
      );
      // A few passing nodes do not excuse parser errors on others. Preserve
      // every incomplete target/check in CI's console as well as the artifact,
      // so a failed rule can be diagnosed even without a browser trace.
      if (why) {
        console.error(
          JSON.stringify(
            {
              error: why.error,
              nodes: why.nodes.map((node) => ({
                target: node.target,
                html: node.html,
                failureSummary: node.failureSummary,
                checks: [...node.any, ...node.all, ...node.none],
              })),
            },
            null,
            2,
          ),
        );
      }
    }
  }

  const serious = violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  if (serious.length) {
    failed = true;
    routeFailed = true;
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
  } else if (!routeFailed && !routeIncomplete) {
    console.log(`OK ${route}`);
  }
}
await browser.close();
if (failed) process.exit(1);
if (manualReviews.length) {
  const count = manualReviews.reduce((sum, review) => sum + review.nodes, 0);
  console.log(
    `\nAutomated a11y gate passed; manual contrast review remains for ${count} node(s) on ${manualReviews.length} route(s).`,
  );
} else {
  console.log('\nNo serious/critical a11y violations.');
}
