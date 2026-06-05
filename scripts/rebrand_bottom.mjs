// BODY-TEXT pass — replaces the baked "phygitals" placard ("phygitals / claw.") + "phygitals.com" on
// the machine BASE with "pokenic / claw." + "pokenic.com". For each it: detects the text via a robust
// anchor (top-left of the dense ink block), stroke-level harmonic-erases the old ink (preserving card
// texture), then BAKES the new text crisply (canvas Poppins, native res) at the detected position/size.
// rebrand_anim.py freezes this static zone onto every animated frame, so each machine stays a single
// self-contained AVIF (matching the live single-AVIF mechanism). The earlier blurry/too-big/wrong-pos
// problems were measurement bugs (fs ~2x too big, drift) — now fixed via the anchor + calibrated fs.
//
// ROBUST ANCHOR approach (the two placard lines overlap vertically — descenders interleave the next
// line's ascenders — so line-splitting is brittle). Instead, per element we detect ONE robust anchor:
// the top-left of the dense dark/light text block (first row whose dark-pixel count clears 40% of the
// peak = top of "phygitals"; leftmost hit = its left edge). Baselines are then derived from the anchor
// via fixed Poppins metrics (ascender 0.72em, line-step 0.86em), so the layout tracks per-machine
// framing drift automatically. Ink colour is sampled from the detected core BEFORE the harmonic
// (Laplace) erase. Both placard lines are erased and BOTH redrawn ("claw." unchanged = lossless).
//
// Machines group by LAYOUT, not sport: pokemon (url high, on the card) / base (white card, url low on
// the base) / riftbound (parchment). Outputs: overwrites {base}-machine.webp and writes a tight
// edit-mask docs/research/packdetail/bottom-mask/{base}.png that rebrand_anim.py freezes onto frames.
// RUN AFTER any lama_compose.mjs run.   node scripts/rebrand_bottom.mjs [base ...]
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const DIR = "public/images/claw";
const MASKDIR = "docs/research/packdetail/bottom-mask";
const OVERLAY_JSON = "docs/research/packdetail/claw-text-coords.json";   // reference: baked-text positions

// fs/baseY/fallback positions are FRACTIONS of image H (vertical) or W (horizontal).
const MODELS = {
  pokemon: {
    bases: ["mythic-pack", "legend-pack", "elite-pack", "platinum-pack", "rookie-pack", "trainer-pack"],
    placard: { band: [0.392, 0.488, 0.762, 0.828], dir: "dark", fs: 0.0145, color: [34, 32, 36] },
    // white-on-white url: detection fails, so a hardcoded fallback. Coords tuned to the real baked
    // "phygitals.com" (≈ x40–49.5%, baseline ≈88.7%) so the erase fully covers it (no faint double).
    url: { band: [0.392, 0.531, 0.870, 0.900], dir: "light", fs: 0.011, color: [232, 232, 235], fallback: { x: 0.396, baseY: 0.887 } },
  },
  base: {   // white card, url low on the base strip — nba (1037) + soccer + black-pack (1440)
    bases: ["legend-pack-1dpaec", "modern-grails-noafw0", "pro-soccer-pack", "black-pack-jjnfuk"],
    placard: { band: [0.368, 0.492, 0.772, 0.840], dir: "dark", fs: 0.016, color: [26, 26, 28] },
    url: { band: [0.305, 0.527, 0.908, 0.953], dir: "light", fs: 0.013, color: [240, 240, 242] },
  },
  riftbound: {
    bases: ["starter-riftbound-pack"],
    placard: { band: [0.365, 0.482, 0.745, 0.812], dir: "dark", fs: 0.015, color: [40, 34, 30] },
    url: { band: [0.355, 0.520, 0.856, 0.897], dir: "light", fs: 0.013, color: [236, 233, 228] },
  },
};
// per-base tweaks (contact-sheet-driven). force = skip detection, use fallback position (for text the
// light/dark detector can't anchor — e.g. faint url on a glossy dark base with bright reflections).
const OVERRIDES = {
  // The base-group cards (nba/riftbound) each sit at a different x and have the dark machine frame
  // close on their left + "VIBES PACKS" close above — both wreck auto-detection — so their placards
  // are PINNED to the measured top-left of the original "phygitals" (+ w = its width fraction).
  // pin.x = original "phygitals" left edge; w = erase width CAPPED at the label's right edge so the
  // erase never reaches the gold box / dark frame — overshooting there masks the shading and paints a
  // white/tan "tab" onto it. Both measured (label-constrained + fine-grid verified), not eyeballed.
  // See bbox_orig_*.png + measure_placard.png.
  "legend-pack-1dpaec": { placard: { pin: { x: 0.406, y: 0.796, w: 0.054 } } },
  "modern-grails-noafw0": { placard: { pin: { x: 0.402, y: 0.795, w: 0.058 } } },
  "starter-riftbound-pack": { placard: { pin: { x: 0.41, y: 0.76, w: 0.06 } } },
  "pro-soccer-pack": {
    // soccer's "phygitals" sits LOWER (≈80%) with "VIBES PACKS" close above it; band top must start
    // below that small text so the anchor lands on "phygitals", not a line too high.
    placard: { band: [0.392, 0.498, 0.793, 0.845] },
    url: { band: [0.356, 0.510, 0.910, 0.950] },
  },
};

const ASC = 0.72;       // Poppins ascender-top -> baseline, in em
const STEP = 0.72;      // placard line-to-line baseline step, in em (tight 2-line label)

const argBases = process.argv.slice(2);
const jobs = [];
for (const [model, cfg] of Object.entries(MODELS)) for (const base of cfg.bases) {
  if (argBases.length && !argBases.includes(base)) continue;
  jobs.push({ base, model, placard: cfg.placard, url: cfg.url });
}

await mkdir(MASKDIR, { recursive: true });
const imgs = {};
for (const j of jobs) imgs[j.base] = "data:image/webp;base64," + (await readFile(`${DIR}/${j.base}-machine.webp`)).toString("base64");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
await page.addStyleTag({ content: "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&display=swap');" });
await page.waitForTimeout(1800);
await page.evaluate(async () => { try { await document.fonts.load("700 40px Poppins"); await document.fonts.load("600 40px Poppins"); } catch {} });

const results = await page.evaluate(async ({ jobs, imgs, OVERRIDES, ASC, STEP }) => {
  const load = (s) => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error("load")); im.src = s; });
  const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const out = {};

  for (const job of jobs) {
    const img = await load(imgs[job.base]);
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    let id = ctx.getImageData(0, 0, W, H);
    const od = new Uint8ClampedArray(id.data);
    const mcv = document.createElement("canvas"); mcv.width = W; mcv.height = H;
    const mctx = mcv.getContext("2d"); mctx.fillStyle = "#000"; mctx.fillRect(0, 0, W, H);

    const log = [], jobCoords = {};
    for (const key of ["placard", "url"]) {
      const el = job[key]; const ov = (OVERRIDES[job.base] || {})[key] || {};
      const band = ov.band || el.band, dir = el.dir;
      const bx0 = Math.round(band[0] * W), bx1 = Math.round(band[1] * W), by0 = Math.round(band[2] * H), by1 = Math.round(band[3] * H);
      const fs = Math.max(8, Math.round((ov.fs ?? el.fs) * H));
      const TH = ov.th ?? (dir === "dark" ? 160 : 135);
      const lum = []; for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { const p = (y * W + x) * 4; lum.push(od[p] + od[p + 1] + od[p + 2]); }
      const medL = med(lum);
      const isHit = (s) => dir === "dark" ? s < medL - TH : s > medL + TH;

      // per-row dark counts -> anchor = top of the dense text block
      const rowc = []; let maxc = 0;
      for (let y = by0; y <= by1; y++) { let c = 0; for (let x = bx0; x <= bx1; x++) { const p = (y * W + x) * 4, s = od[p] + od[p + 1] + od[p + 2]; if (isHit(s)) c++; } rowc.push(c); if (c > maxc) maxc = c; }
      const hits = [];
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { const p = (y * W + x) * 4, s = od[p] + od[p + 1] + od[p + 2]; if (isHit(s)) hits.push([x, y, od[p], od[p + 1], od[p + 2], s]); }

      let anchorX, anchorY, blockRight, blockBot, color, detected = true;
      const minHits = Math.max(25, (bx1 - bx0) * (by1 - by0) * 0.003);
      if (ov.pin) {
        // PINNED placard. Detection is unreliable on the base-group cards (the dark frame seam left of
        // the card pulls the left anchor off; "VIBES PACKS" above pulls the top anchor up). pin =
        // measured top-left of the original "phygitals" + w = its width fraction (erase right edge).
        anchorX = Math.round(ov.pin.x * W);
        anchorY = Math.round(ov.pin.y * H);
        blockRight = Math.round((ov.pin.x + (ov.pin.w ?? 0.12)) * W);
        blockBot = anchorY + Math.round((ASC + STEP + 0.2) * fs);
        color = ov.color || el.color;
      } else if (!ov.force && maxc >= 4 && hits.length >= minHits) {
        const rth = maxc * 0.4;
        // First dense row from the top = top of "phygitals" (works when the band top sits just above
        // "phygitals", i.e. pokemon + the soccer override). The base-group cards, where "VIBES PACKS"
        // intrudes and the frame pollutes the left edge, are PINNED instead (handled above).
        let topIdx = -1;
        for (let i = 0; i < rowc.length; i++) if (rowc[i] >= rth) { topIdx = i; break; }
        let botIdx = topIdx, gap = 0;
        const gapTol = Math.max(2, Math.round(0.45 * fs));
        for (let i = topIdx; i < rowc.length; i++) { if (rowc[i] >= rth) { botIdx = i; gap = 0; } else if (++gap > gapTol) break; }
        const topRow = by0 + topIdx, botRow = by0 + botIdx;
        anchorY = topRow;
        let lx = 1e9, rx = -1;
        for (const [x, y] of hits) if (y >= topRow && y <= botRow) { if (x < lx) lx = x; if (x > rx) rx = x; }
        anchorX = lx; blockRight = rx; blockBot = botRow;
        color = ov.color || el.color;            // hardcoded ink colour (sampling caught holo tints)
      } else {                                   // undetectable (white-on-white url) or forced: hardcode
        detected = false;
        const fb = ov.fallback || el.fallback || { x: band[0], baseY: (band[2] + band[3]) / 2 };
        anchorX = Math.round(fb.x * W); anchorY = Math.round(fb.baseY * H) - Math.round(ASC * fs);
        blockRight = bx1; blockBot = anchorY + (key === "placard" ? Math.round(STEP * fs) + fs : fs);
        color = ov.color || el.color || (dir === "dark" ? [30, 30, 32] : [234, 234, 236]);
      }

      // SHARP erase (NO blur, NO flat patch). Build a dilated mask of the original text STROKES, then
      // fill each masked pixel with the NEAREST real CARD pixel on its row (left or right). It copies
      // actual card pixels (true colour + holographic tint) crisply — no smooth Laplace interpolation
      // (so no blur halo) and no single flat colour (so no visible rectangle).
      const pad = 2;
      const ex0 = Math.max(0, anchorX - pad), ex1 = Math.min(W - 1, blockRight + pad);
      const ey0 = Math.max(0, anchorY - pad);
      // The placard is TWO lines (pokenic + claw.). The contiguous block detection can stop after
      // line 1, leaving the original "claw." un-erased under the redrawn one (the doubled "claw."
      // bug). Extend the erase down past BOTH baselines (anchorY + ascender + line-step), but stop
      // before the rule line / Mew below. The url is one line, so keep its detected block.
      const ey1 = Math.min(H - 1, (key === "placard" ? Math.round(anchorY + (ASC + STEP + 0.15) * fs) : blockBot) + pad);
      const mw = ex1 - ex0 + 1, mh = ey1 - ey0 + 1, M = new Uint8Array(mw * mh), DIL = 2;
      if (!detected) {
        // white-on-white url (no detectable strokes to mask): erase the WHOLE band rect, else the
        // original faint "phygitals.com" survives under the redrawn "pokenic.com".
        M.fill(1);
      } else {
        for (let gy = ey0; gy <= ey1; gy++) for (let gx = ex0; gx <= ex1; gx++) {
          const p = (gy * W + gx) * 4;
          if (isHit(od[p] + od[p + 1] + od[p + 2])) for (let dy = -DIL; dy <= DIL; dy++) for (let dx = -DIL; dx <= DIL; dx++) {
            const ny = gy - ey0 + dy, nx = gx - ex0 + dx; if (ny >= 0 && ny < mh && nx >= 0 && nx < mw) M[ny * mw + nx] = 1;
          }
        }
      }
      const masked = (gx, gy) => gx >= ex0 && gx <= ex1 && gy >= ey0 && gy <= ey1 && M[(gy - ey0) * mw + (gx - ex0)];
      const px = id.data;
      for (let gy = ey0; gy <= ey1; gy++) for (let gx = ex0; gx <= ex1; gx++) {
        if (!masked(gx, gy)) continue;
        let lx = gx - 1; while (lx >= 0 && masked(lx, gy)) lx--;
        let rx = gx + 1; while (rx < W && masked(rx, gy)) rx++;
        let src = -1;
        if (lx >= 0 && rx < W) src = (gx - lx <= rx - gx) ? lx : rx; else if (lx >= 0) src = lx; else if (rx < W) src = rx; else continue;
        const sp = (gy * W + src) * 4, dp = (gy * W + gx) * 4;
        px[dp] = od[sp]; px[dp + 1] = od[sp + 1]; px[dp + 2] = od[sp + 2]; px[dp + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);

      // Bake the brand text crisply into the image (canvas Poppins at NATIVE resolution) at the exact
      // detected position/size — a single self-contained animated AVIF, matching the live single-AVIF
      // mechanism. rebrand_anim.py then freezes this static placard/url zone onto every frame.
      const base1 = anchorY + ASC * fs;
      ctx.font = `${key === "placard" ? 700 : 600} ${fs}px Poppins, sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
      if (key === "placard") { ctx.fillText("pokenic", anchorX, base1); ctx.fillText("claw.", anchorX, base1 + STEP * fs); }
      else ctx.fillText("pokenic.com", anchorX, base1);
      id = ctx.getImageData(0, 0, W, H);   // re-sync so the next element + frozen frames include this text

      // Coords still emitted for reference (a DOM overlay could use them), but the text is baked above.
      jobCoords[key] = {
        left: +(anchorX / W * 100).toFixed(2),
        top: +(anchorY / H * 100).toFixed(2),
        fs: +(fs / H * 100).toFixed(3),
        step: +(STEP * fs / H * 100).toFixed(3),
        color: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
        detected,
      };

      mctx.fillStyle = "#fff"; mctx.fillRect(ex0, ey0, ex1 - ex0 + 1, ey1 - ey0 + 1);
      log.push(`${key}: ${detected ? "det" : "FALLBK"} anchor=(${Math.round(anchorX / W * 1000) / 10}%,${Math.round(anchorY / H * 1000) / 10}%) right=${Math.round(blockRight / W * 1000) / 10}% fs=${fs} color=rgb(${color}) hits=${hits.length}`);
    }
    out[job.base] = { webp: cv.toDataURL("image/webp", 0.95), mask: mcv.toDataURL("image/png"), W, H, log, coords: jobCoords };
  }
  return out;
}, { jobs, imgs, OVERRIDES, ASC, STEP });

const overlay = {};
for (const [base, r] of Object.entries(results)) {
  await writeFile(`${DIR}/${base}-machine.webp`, Buffer.from(r.webp.split(",")[1], "base64"));
  await writeFile(`${MASKDIR}/${base}.png`, Buffer.from(r.mask.split(",")[1], "base64"));
  overlay[base] = r.coords;
  console.log(`${base} (${r.W}x${r.H}):`);
  for (const l of r.log) console.log(`   ${l}`);
}
// Merge into the overlay-coords JSON consumed by the component (so partial runs don't drop others).
let existing = {};
try { existing = JSON.parse(await readFile(OVERLAY_JSON, "utf8")); } catch {}
await writeFile(OVERLAY_JSON, JSON.stringify({ ...existing, ...overlay }, null, 2));
await browser.close();
console.log(`\n${Object.keys(results).length} machines: baked "phygitals" blanked, edit-mask + overlay coords written -> ${OVERLAY_JSON}`);
