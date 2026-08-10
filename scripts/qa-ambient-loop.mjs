// qa-ambient-loop.mjs — proves the ambient bed loops through WebAudio (gapless
// AudioBufferSourceNode) rather than HTMLAudioElement.loop, which plays the
// MP3's encoder padding as an audible gap every lap.
// Usage: node scripts/qa-ambient-loop.mjs [baseUrl]
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
// bronze-pack is the only spinnable pack; ?demo=1 spins without a purchase.
const URL = `${BASE}/slots/bronze-pack/spin?demo=1`;

const browser = await chromium.launch({
  // Autoplay unlock without a real gesture, so the bed can start headless.
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

// Record every looping source that starts, and every <audio> that loops.
await page.addInitScript(() => {
  const w = /** @type {any} */ (window);
  w.__loops = { buffer: [], element: [] };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    if (this.loop) {
      w.__loops.buffer.push({
        duration: this.buffer ? this.buffer.duration : null,
      });
    }
    return start.apply(this, args);
  };
  const play = HTMLAudioElement.prototype.play;
  HTMLAudioElement.prototype.play = function (...args) {
    if (this.loop) w.__loops.element.push(this.src);
    return play.apply(this, args);
  };
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page
  .getByRole('button', { name: 'Accept' })
  .click({ timeout: 5000 })
  .catch(() => {});

const spin = page.getByRole('button', { name: /spin|open/i }).first();
await spin.waitFor({ state: 'visible', timeout: 20000 });
await spin.click();
// The bed starts on the same beat as the reels; give the fetch+decode a moment.
await page.waitForTimeout(6000);

const loops = await page.evaluate(() => window.__loops);
console.log(JSON.stringify(loops, null, 2));
await browser.close();

if (loops.buffer.length === 0) {
  throw new Error(
    'FAIL: no looping AudioBufferSourceNode started — the bed fell back to ' +
      'HTMLAudioElement.loop, which is the gappy path.',
  );
}
if (loops.element.length > 0) {
  throw new Error(
    `FAIL: an <audio> element looped: ${loops.element.join(',')}`,
  );
}
console.log('PASS: ambient bed loops through a decoded AudioBuffer.');
