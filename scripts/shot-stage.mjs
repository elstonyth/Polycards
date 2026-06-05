// Screenshot the claw-machine STAGE (the bordered frame) with the machine inside it, so we can see
// the gap between the machine render and its frame. Captures the img's parent (the stage div).
import { chromium } from "playwright";

const slug = process.argv[2] || "nba-legend";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:4000/claw/${slug}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const img = page.locator('img[alt*="claw machine"]').first();
await img.waitFor({ state: "visible", timeout: 8000 });
const stage = img.locator("xpath=..");           // the stage div (frame)
const b = await stage.boundingBox();
await page.screenshot({
  path: `docs/research/packdetail/stage_${slug}.png`,
  clip: { x: b.x, y: b.y, width: b.width, height: b.height },
});
const ib = await img.boundingBox();
console.log(`stage ${Math.round(b.width)}x${Math.round(b.height)} (ar ${(b.width/b.height).toFixed(3)})  machine ${Math.round(ib.width)}x${Math.round(ib.height)} (ar ${(ib.width/ib.height).toFixed(3)})`);
console.log(`machine fills: ${Math.round(ib.width/b.width*100)}% width, ${Math.round(ib.height/b.height*100)}% height`);
await browser.close();
