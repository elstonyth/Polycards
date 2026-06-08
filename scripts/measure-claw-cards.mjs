// Measure /claw pack-card geometry on the LIVE site vs the clone at 1440px so the
// proportions can be matched from numbers, not eyeballing.
import { chromium } from "playwright";

const browser = await chromium.launch();

async function measure(label, url) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
    const data = await page.evaluate(() => {
      // A "card" = the smallest element that contains BOTH an <img> and a button/link
      // whose text is "Open" (the live + clone pack cards).
      const isOpen = (el) => /^open$/i.test((el.innerText || "").trim());
      const opens = [...document.querySelectorAll("button,a")].filter(isOpen);
      const cards = opens
        .map((b) => {
          let el = b;
          for (let i = 0; i < 6; i++) {
            el = el.parentElement;
            if (!el) break;
            if (el.querySelector("img")) return el;
          }
          return null;
        })
        .filter(Boolean);
      if (!cards.length) return { error: "no cards found", openCount: opens.length };
      const card = cards[0];
      const cr = card.getBoundingClientRect();
      const img = card.querySelector("img");
      const ir = img.getBoundingClientRect();
      // grid container
      const grid = card.parentElement;
      const gcs = getComputedStyle(grid);
      return {
        cardCount: cards.length,
        card: { w: Math.round(cr.width), h: Math.round(cr.height), aspect: +(cr.width / cr.height).toFixed(2) },
        img: { w: Math.round(ir.width), h: Math.round(ir.height), natW: img.naturalWidth, natH: img.naturalHeight, natAspect: img.naturalHeight ? +(img.naturalWidth / img.naturalHeight).toFixed(2) : null },
        grid: { display: gcs.display, cols: gcs.gridTemplateColumns?.split(" ").length, gap: gcs.gap || gcs.columnGap },
        cardPadding: getComputedStyle(card).padding,
      };
    });
    return { label, url, ...data };
  } catch (e) {
    return { label, url, error: String(e).slice(0, 140) };
  }
}

const live = await measure("LIVE", "https://www.phygitals.com/claw");
const clone = await measure("CLONE", "http://localhost:4000/claw");
await browser.close();
console.log(JSON.stringify({ live, clone }, null, 2));
