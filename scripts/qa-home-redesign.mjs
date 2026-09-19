// scripts/qa-home-redesign.mjs
// One-off QA: screenshots of the Drop Board home at phone/desktop, plus a
// reduced-motion pass and the routing-rule audit (every product tap → /slots).
// Usage: node scripts/qa-home-redesign.mjs   (expects the standalone server)
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const OUT = 'docs/research';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
try {
  for (const [name, viewport, reducedMotion] of [
    ['home-drop-small', { width: 320, height: 740 }, 'reduce'],
    ['home-drop-phone', { width: 390, height: 844 }, 'no-preference'],
    ['home-drop-tablet', { width: 768, height: 1024 }, 'reduce'],
    ['home-drop-desktop', { width: 1440, height: 900 }, 'no-preference'],
    ['home-drop-phone-reduced', { width: 390, height: 844 }, 'reduce'],
  ]) {
    const ctx = await browser.newContext({ viewport, reducedMotion });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });

    // Dismiss the cookie banner so it doesn't overlay the boards.
    const accept = page.getByRole('button', { name: 'Accept' });
    if (await accept.isVisible().catch(() => false)) await accept.click();

    const hero = page.locator('section[aria-labelledby="hero-heading"]');
    if (process.env.PW_EXPECT_HITS) {
      assert.equal(
        await hero.locator('[data-hero-hit]').count(),
        Number(process.env.PW_EXPECT_HITS),
      );
    }
    assert.equal(await page.locator('main h1').count(), 1);
    assert.match(
      await hero.innerText(),
      /Open packs\.[\s\S]*Pull real cards\./,
    );
    assert.doesNotMatch(
      await hero.locator('h1').innerText(),
      /Pok[eé]mon|One Piece/i,
    );
    assert.equal(
      await hero
        .getByRole('link', { name: 'Open a pack', exact: true })
        .getAttribute('href'),
      '/slots',
    );
    assert.equal(
      await hero
        .getByRole('link', { name: 'How it works' })
        .getAttribute('href'),
      '/how-it-works',
    );
    await hero
      .locator('img')
      .evaluateAll((images) =>
        Promise.all(images.map((image) => image.decode())),
      );
    assert.ok(
      await page
        .locator('main img')
        .evaluateAll((images) =>
          images.every(
            (image) => !decodeURIComponent(image.src).includes('/home/hero/'),
          ),
        ),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name}: horizontal overflow`,
    );
    if (reducedMotion === 'reduce') {
      assert.equal(
        await hero.evaluate(
          (element) =>
            element
              .getAnimations({ subtree: true })
              .filter(
                (animation) =>
                  animation.effect?.getTiming().iterations === Infinity,
              ).length,
        ),
        0,
      );
    }

    const openPack = hero.getByRole('link', {
      name: 'Open a pack',
      exact: true,
    });
    // Trial performs Playwright's hit-target check without leaving the page.
    await openPack.click({ trial: true });
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.screenshot({ path: `${OUT}/${name}-top.png` });

    // Scroll through the page so every fire-once Reveal (IntersectionObserver)
    // has triggered — otherwise below-the-fold boards capture at opacity-0.
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = () => {
          y += 600;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight) setTimeout(step, 120);
          else resolve(undefined);
        };
        step();
      });
    });
    await page.waitForTimeout(900); // let the last reveal transition finish
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    await page.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });

    const slabs = hero.locator('[data-hero-hit]');
    if ((await slabs.count()) > 1) {
      const selected = () =>
        hero.locator('[data-hero-hit][aria-pressed="true"]');
      const selection = () => selected().getAttribute('data-hero-hit');
      const next = hero.getByRole('button', { name: 'Next card', exact: true });
      const caption = hero.locator('[data-hit-name]');

      if (name === 'home-drop-desktop') {
        // Verify a complete automatic cycle, including wrapping to the first hit.
        const first = await selection();
        for (let turn = 0; turn < 3; turn++) {
          const before = await selection();
          await expect.poll(selection, { timeout: 5500 }).not.toBe(before);
          await expect(caption).toHaveText(
            (await selected().getAttribute('aria-label')).replace(/^Show /, ''),
          );
          assert.equal(await selected().getAttribute('data-position'), '0');
        }
        assert.equal(await selection(), first);

        await hero.getByRole('button', { name: 'Pause card rotation' }).click();
        await page.mouse.move(0, 0);
        const stopped = await selection();
        await page.waitForTimeout(4500);
        assert.equal(await selection(), stopped);
        await hero
          .getByRole('button', { name: 'Resume card rotation' })
          .click();
        await page.mouse.move(0, 0);
        await expect.poll(selection, { timeout: 5500 }).not.toBe(stopped);

        await hero.locator('figure').hover();
        const hovered = await selection();
        await page.waitForTimeout(4500);
        assert.equal(await selection(), hovered);
        await page.mouse.move(0, 0);
        await next.focus();
        await page.waitForTimeout(4500);
        assert.equal(await selection(), hovered);
      }

      if (name === 'home-drop-phone-reduced') {
        const still = await selection();
        await page.waitForTimeout(4500);
        assert.equal(await selection(), still);
        await expect(
          hero.getByRole('button', { name: /card rotation/ }),
        ).toBeHidden();
      }

      const before = Number(await selection());
      await next.click();
      assert.equal(
        Number(await selection()),
        (before % (await slabs.count())) + 1,
      );
      await expect(caption).toHaveText(
        (await selected().getAttribute('aria-label')).replace(/^Show /, ''),
      );
      await page.waitForTimeout(reducedMotion === 'reduce' ? 0 : 750);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({ path: `${OUT}/${name}-rotated.png` });
      console.log(`[${name}] card rotation and caption OK`);
    }

    // Routing-rule audit: every anchor inside the six boards that shows a
    // product must point at exactly "/slots".
    // (page.$$eval is Playwright's typed DOM-query helper running a static
    // function in page context — not string eval; no arbitrary code here.)
    // Operator exception (2026-08-06): RIP A PACK ladder rows deep-link to the
    // pack they show (`/slots/<slug>?count=1`). Every other product surface
    // still lands on plain "/slots", so the audit skips that section only.
    const offenders = await page.$$eval('main a[href^="/slots/"]', (as) =>
      as
        .filter((a) => !a.closest('section[aria-labelledby="shelf-heading"]'))
        .map((a) => a.getAttribute('href')),
    );
    if (offenders.length === 0) {
      console.log(`[${name}] routing rule OK — no /slots/<pack> links on home`);
    } else {
      console.log(`[${name}] ROUTING VIOLATIONS: ${offenders.join(', ')}`);
      process.exitCode = 1; // usable as a gate, not just a log
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log('screenshots in', OUT);
