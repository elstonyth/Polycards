// scripts/qa-card-tilt.mjs
// Verify the face-down card's pointer tilt + glare on the PROD build (:4000),
// signed out (demo spin — no login, no charge):
//   1. the card tilts toward the pointer and the glare lights up
//   2. opposite corners tilt opposite ways (it follows, not just "moves")
//   3. it eases back to flat when the pointer leaves
//   4. a real (click-emitting) DRAG turns the card and does NOT flip it
//   5. the idle float keeps running — the tilt transform must not eat it
//   6. a tap still flips the card (the tilt must never eat the reveal)
//   7. prefers-reduced-motion: reduce keeps it flat and unlit
//   8. no page errors
// Run: node scripts/qa-card-tilt.mjs
import { chromium } from 'playwright';

const BASE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
const PACK = process.env.QA_PACK ?? 'bronze-pack';
const CARD = 'button[aria-label="Flip to reveal your card"]';

let failed = false;
const ok = (m) => console.log(`\u2713 ${m}`);
const fail = (m) => {
  console.error(`\u2717 ${m}`);
  failed = true;
};

/** Spin the demo machine and wait for the face-down card. */
async function toReveal(page) {
  await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2000); // sprites paint + auth mode resolves (demo)
  await page
    .getByRole('button', { name: /demo spin|^spin$/i })
    .first()
    .click();
  await page.waitForSelector(CARD, { timeout: 30_000 });
  await page.waitForTimeout(600);
}

const rect = (page) =>
  page.$eval(CARD, (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });

/** The button's own translateY, which the idle float drives. */
const floatY = (page) =>
  page.$eval(CARD, (el) => new DOMMatrix(getComputedStyle(el).transform).m42);

const vars = (page) =>
  page.$eval(CARD, (el) => {
    const s = getComputedStyle(el);
    const m = new DOMMatrix(s.transform);
    return {
      tiltX: s.getPropertyValue('--tilt-x').trim(),
      tiltY: s.getPropertyValue('--tilt-y').trim(),
      glare: parseFloat(s.getPropertyValue('--glare-o') || '0'),
      // m13/m23 are the 3D shear the tilt introduces — 0 on a flat card.
      lean: Math.abs(m.m13) + Math.abs(m.m23),
    };
  });

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await toReveal(page);
  const box = await rect(page);
  const at = async (fx, fy) => {
    await page.mouse.move(box.x + box.w * fx, box.y + box.h * fy);
    await page.waitForTimeout(350); // let the rAF ease settle
    return vars(page);
  };

  const tl = await at(0.12, 0.12);
  const br = await at(0.88, 0.88);
  if (tl.lean > 0.02 && br.lean > 0.02)
    ok(`card leans (${br.lean.toFixed(3)})`);
  else fail(`card never leaves flat (tl=${tl.lean}, br=${br.lean})`);

  const deg = (v) => parseFloat(v);
  if (
    deg(tl.tiltX) > 1 &&
    deg(br.tiltX) < -1 &&
    deg(tl.tiltY) < -1 &&
    deg(br.tiltY) > 1
  )
    ok(
      `follows the pointer (tl ${tl.tiltX}/${tl.tiltY}, br ${br.tiltX}/${br.tiltY})`,
    );
  else
    fail(
      `tilt does not track the pointer (tl ${tl.tiltX}/${tl.tiltY}, br ${br.tiltX}/${br.tiltY})`,
    );

  if (br.glare > 0.5) ok(`glare lit (${br.glare.toFixed(2)})`);
  else fail(`glare stayed dark (${br.glare})`);

  await page.mouse.move(box.x + box.w / 2, box.y + box.h + 220);
  await page.waitForTimeout(700);
  const away = await vars(page);
  if (away.lean < 0.02 && away.glare < 0.05)
    ok('eases back to flat and unlit on leave');
  else
    fail(
      `stuck tilted/lit after leave (lean=${away.lean}, glare=${away.glare})`,
    );

  // A finger never hovers: it lands, drags, lifts. Dispatch a real touch
  // pointer stream (Playwright's touchscreen only taps) and check the card
  // turns under it — this is the mobile gesture, not a second mouse test.
  // A real mouse drag emits a real `click` on pointerup — the exact path that
  // would flip the card mid-turn. The hook must swallow that click past its
  // slop threshold while leaving a plain tap alone.
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(
      box.x + box.w * (0.5 + i * 0.02),
      box.y + box.h * (0.5 - i * 0.015),
    );
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300); // let the rAF ease reach the held angle
  const dragging = await vars(page);
  await page.mouse.up();
  await page.waitForTimeout(400);
  if (dragging.lean > 0.02)
    ok(`mouse drag turns the card (lean ${dragging.lean.toFixed(3)})`);
  else fail(`mouse drag did not turn the card (lean=${dragging.lean})`);
  if (await page.$(CARD)) ok('a drag does NOT flip the card');
  else fail('a drag FLIPPED the card — the click is not being swallowed');

  await page.screenshot({
    path: 'docs/research/qa-card-tilt.png',
    clip: {
      x: Math.round(box.x) - 20,
      y: Math.round(box.y) - 20,
      width: Math.round(box.w) + 40,
      height: Math.round(box.h) + 40,
    },
  });

  const touchDrag = await page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    const b = el.getBoundingClientRect();
    const send = (type, fx, fy) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          clientX: b.x + b.width * fx,
          clientY: b.y + b.height * fy,
        }),
      );
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    send('pointerdown', 0.5, 0.5);
    for (let i = 0; i < 40; i++) {
      send('pointermove', 0.5 + i * 0.01, 0.5 - i * 0.008);
      await frame();
    }
    const s = getComputedStyle(el);
    const held = {
      rx: parseFloat(s.getPropertyValue('--tilt-x')),
      ry: parseFloat(s.getPropertyValue('--tilt-y')),
      glare: parseFloat(s.getPropertyValue('--glare-o') || '0'),
      touchAction: s.touchAction,
    };
    send('pointerup', 0.9, 0.18);
    return held;
  }, CARD);
  if (touchDrag.ry > 2 && touchDrag.rx > 1 && touchDrag.glare > 0.5)
    ok(
      `touch drag turns the card (rx ${touchDrag.rx.toFixed(1)}, ry ${touchDrag.ry.toFixed(1)}, glare ${touchDrag.glare.toFixed(2)})`,
    );
  else fail(`touch drag did not turn the card (${JSON.stringify(touchDrag)})`);
  if (touchDrag.touchAction === 'none')
    ok('card claims the drag gesture (touch-action: none)');
  else
    fail(
      `page scroll will steal the drag (touch-action: ${touchDrag.touchAction})`,
    );
  await page.waitForTimeout(700);

  // The idle float is the operator's explicitly-kept beat: the tilt rides in
  // motion's transformTemplate precisely so it can't eat it. Pointer parked
  // away, translateY must still be moving.
  await page.mouse.move(box.x + box.w / 2, box.y + box.h + 220);
  await page.waitForTimeout(500);
  const ys = [];
  for (let i = 0; i < 5; i++) {
    ys.push(await floatY(page));
    await page.waitForTimeout(550);
  }
  const swing = Math.max(...ys) - Math.min(...ys);
  if (swing > 1) ok(`idle float still running (${swing.toFixed(2)}px swing)`);
  else fail(`idle float is gone (${swing.toFixed(2)}px swing over 2.2s)`);

  // force: the card idle-floats, so Playwright's stability wait never settles
  await page.click(CARD, { force: true });
  await page.waitForTimeout(1200);
  const flipped = await page.$(CARD);
  if (!flipped) ok('tap still flips the card');
  else fail('tap did NOT flip the card — tilt is eating the reveal');

  if (pageErrors.length === 0) ok('no page errors');
  else fail(`page errors: ${pageErrors.join(' | ')}`);
  await ctx.close();

  // reduced motion: flat and unlit, and the flip still works
  const rctx = await browser.newContext({ reducedMotion: 'reduce' });
  const rpage = await rctx.newPage();
  await toReveal(rpage);
  const rbox = await rect(rpage);
  await rpage.mouse.move(rbox.x + rbox.w * 0.85, rbox.y + rbox.h * 0.85);
  await rpage.waitForTimeout(400);
  const r = await vars(rpage);
  const rTouch = await rpage.$eval(
    CARD,
    (el) => getComputedStyle(el).touchAction,
  );
  if (rTouch !== 'none') ok('reduced motion: page keeps the scroll gesture');
  else fail('reduced motion still swallows the scroll gesture');
  if (r.lean < 0.02 && r.glare < 0.05) ok('reduced motion: flat and unlit');
  else fail(`reduced motion still tilts (lean=${r.lean}, glare=${r.glare})`);
  await rctx.close();
} finally {
  await browser.close();
}

console.log(failed ? '\nFAILURES' : '\nALL PASS');
process.exit(failed ? 1 : 0);
