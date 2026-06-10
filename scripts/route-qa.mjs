// ADD-ON A — controlled single-browser render pass over all 41 storefront routes
// against the PRODUCTION server (npx next start -p 4000). ONE browser, sequential —
// avoids the 41-concurrent-Playwright runaway-process risk (see CLAUDE.md).
// Writes docs/research/route-qa/<slug>.png + manifest.json for the workflow to corroborate.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/research/route-qa";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:4000";

// route = the plan's route identifier (with [brackets]); url = concrete URL (params resolved)
const ROUTES = [
  { route: "/", url: "/" },
  { route: "/marketplace", url: "/marketplace" },
  { route: "/claw", url: "/claw" },
  { route: "/claw/[slug]", url: "/claw/pokemon-mythic" },
  { route: "/card/[id]", url: "/card/charizard-ex-scarlet-violet-151-1" },
  { route: "/profile/[user]", url: "/profile/ProfessorOak" },
  { route: "/login", url: "/login" },
  { route: "/signup", url: "/signup" },
  { route: "/orders", url: "/orders" },
  { route: "/settings", url: "/settings" },
  { route: "/leaderboard", url: "/leaderboard" },
  { route: "/roulette", url: "/roulette" },
  { route: "/lucky-draw", url: "/lucky-draw" },
  { route: "/repacks", url: "/repacks" },
  { route: "/free", url: "/free" },
  { route: "/store", url: "/store" },
  { route: "/clawmaker", url: "/clawmaker" },
  { route: "/activity", url: "/activity" },
  { route: "/fairness", url: "/fairness" },
  { route: "/series", url: "/series" },
  { route: "/pokemon/generation/[gen]", url: "/pokemon/generation/1" },
  { route: "/messages", url: "/messages" },
  { route: "/achievements", url: "/achievements" },
  { route: "/submitcards", url: "/submitcards" },
  { route: "/earnings", url: "/earnings" },
  { route: "/referrals", url: "/referrals" },
  { route: "/vouchers", url: "/vouchers" },
  { route: "/bank-withdrawal", url: "/bank-withdrawal" },
  { route: "/borrow-lend", url: "/borrow-lend" },
  { route: "/pokecoin", url: "/pokecoin" },
  { route: "/nbacoin", url: "/nbacoin" },
  { route: "/accelerate-claim", url: "/accelerate-claim" },
  { route: "/airdrop", url: "/airdrop" },
  { route: "/launchpad/[brand]", url: "/launchpad/fwog" },
  { route: "/about", url: "/about" },
  { route: "/contact", url: "/contact" },
  { route: "/how-it-works", url: "/how-it-works" },
  { route: "/pack-party", url: "/pack-party" },
  { route: "/social", url: "/social" },
  { route: "/merchants", url: "/merchants" },
  { route: "/30th", url: "/30th" },
];

const slugOf = (route) =>
  route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "_").replace(/[[\]]/g, "");

const browser = await chromium.launch();
const manifest = [];
const log = [];

for (const { route, url } of ROUTES) {
  const slug = slugOf(route);
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce", // Reveal renders content visible immediately under reduced-motion
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + (e.message || String(e)).slice(0, 300)));

  let httpStatus = null, finalUrl = url, stats = {}, error = null;
  try {
    const resp = await page.goto(BASE + url, { waitUntil: "load", timeout: 60000 });
    httpStatus = resp ? resp.status() : null;
    // trigger any lazy/scroll-reveal content, then return to top
    for (let y = 0; y < 4000; y += 500) { await page.evaluate((v) => scrollTo(0, v), y); await page.waitForTimeout(120); }
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(500);
    finalUrl = page.url().replace(BASE, "");
    stats = await page.evaluate(() => {
      const scope = document.querySelector("main") || document.body;
      const scopedToMain = !!document.querySelector("main");
      const q = (sel) => scope.querySelectorAll(sel).length;
      const text = scope.innerText || "";
      const moneyRe = /\b(coin|coins|balance|withdraw|withdrawal|payout|cash\s?out|token|tokens|wallet|airdrop|earnings|on[-\s]?chain|mint|minted|staking|stake|crypto|deposit|borrow|lend|lending|voucher|vouchers|referral|referrals|\$[\d,]+)\b/gi;
      const moneyHits = Array.from(new Set((text.match(moneyRe) || []).map((s) => s.toLowerCase()))).slice(0, 18);
      const demoRe = /\b(demo|coming soon|backend|goes? live|not yet|placeholder|sign in to|log in to|connect your|stay tuned|under construction)\b/gi;
      const demoHits = Array.from(new Set((text.match(demoRe) || []).map((s) => s.toLowerCase()))).slice(0, 12);
      return {
        title: document.title,
        scopedToMain,
        buttons: q("button"),
        inputs: q("input"),
        selects: q("select"),
        textareas: q("textarea"),
        forms: q("form"),
        roleButtons: q('[role="button"]'),
        links: q("a"),
        moneyHits,
        demoHits,
        textLen: text.length,
      };
    });
    await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: true });
  } catch (e) {
    error = (e.message || String(e)).slice(0, 300);
  }

  const interactiveCount =
    (stats.buttons || 0) + (stats.inputs || 0) + (stats.selects || 0) + (stats.textareas || 0) +
    (stats.forms || 0) + (stats.roleButtons || 0);

  manifest.push({
    route, url, finalUrl, slug, screenshot: `${OUT}/${slug}.png`,
    httpStatus, error, interactiveCount, ...stats, consoleErrors,
  });
  log.push(
    `${route.padEnd(28)} http=${httpStatus ?? "ERR"} int=${interactiveCount} ` +
    `(btn=${stats.buttons ?? "?"} inp=${stats.inputs ?? "?"} form=${stats.forms ?? "?"}) ` +
    `money=${(stats.moneyHits || []).length} demo=${(stats.demoHits || []).length} ` +
    `errs=${consoleErrors.length}${error ? " FAIL:" + error : ""}`
  );
  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(log.join("\n"));
console.log(`\nwrote ${manifest.length} routes -> ${OUT}/manifest.json`);
