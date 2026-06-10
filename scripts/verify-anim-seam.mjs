// Freeze-SEAM check (headed — headless pauses AVIF). For each slug, capture N frames of the playing
// machine's BOTTOM strip (the frozen placard/url zone + its surroundings). If the bottom-mask freeze
// over a MOVING base pixel created a static-rectangle seam, it shows as a sharp zero-motion rect
// against moving surroundings. seam_check.py then computes the motion map. Run with prod server on :4000.
//   node scripts/verify-anim-seam.mjs nba-legend nba-platinum
import { chromium } from "playwright";

const OUT = "docs/research/packdetail";
const slugs = process.argv.slice(2);
if (!slugs.length) slugs.push("nba-legend");
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

for (const slug of slugs) {
  await page.goto(`http://localhost:4000/claw/${slug}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.bringToFront();
  await page.waitForTimeout(1200);
  const img = page.locator('img[alt*="claw machine"]').first();
  const box = await img.boundingBox();
  if (!box) { console.log(`${slug}: no machine`); continue; }
  // bottom strip: placard + base url zone (≈ y 68–98% of the machine box)
  const clip = { x: Math.round(box.x), y: Math.round(box.y + 0.68 * box.height), width: Math.round(box.width), height: Math.round(0.30 * box.height) };
  for (let i = 0; i < 9; i++) {
    await page.screenshot({ path: `${OUT}/seam_${slug}_${i}.png`, clip });
    await page.waitForTimeout(450);   // ~9 frames over ~4s ≈ one full loop
  }
  console.log(`${slug}: 9 bottom-strip frames captured (${clip.width}x${clip.height})`);
}
await browser.close();
console.log("done");
