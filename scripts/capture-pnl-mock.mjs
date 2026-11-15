// Design check of the admin P&L page with the admin API answered from fixtures
// inside this test browser only (the real backend is never signed in to).
// Usage: node scripts/capture-pnl-mock.mjs <fixture.json> <outDir> [probe]
// Needs only the admin UI on :7000 (no admin sign-in, no TOTP). The fixture is
// { month, all } P&L responses, e.g. dumped from a read-only prod replay.
import { pathToFileURL } from "node:url";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const { chromium } = await import(
  pathToFileURL(REPO + "node_modules/playwright/index.mjs").href
);
const [fixtureFile, outDir, probe] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
mkdirSync(outDir, { recursive: true });
const ADMIN = "http://localhost:7000/dashboard";

const user = {
  id: "user_mock",
  email: "mock-admin@local.test",
  first_name: "Mock",
  last_name: "Admin",
  metadata: {},
  roles: [],
  rbac_roles: [],
};

const browser = await chromium.launch();
const seen = new Map();
const errors = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 3400 },
  });
  await ctx.route("http://localhost:9000/**", async (route) => {
    const u = new URL(route.request().url());
    const key = `${route.request().method()} ${u.pathname}`;
    if (u.pathname === "/admin/users/me")
      return route.fulfill({ json: { user } });
    if (u.pathname === "/auth/session")
      return route.fulfill({ json: { user } });
    if (u.pathname === "/admin/rbac/me/permissions")
      return route.fulfill({
        json: { permissions: ["*:*", "profit_report:read", "payment:read", "store:read"] },
      });
    if (u.pathname === "/admin/stores")
      return route.fulfill({
        json: {
          stores: [{ id: "store_mock", name: "Polycards", supported_currencies: [{ currency_code: "myr", is_default: true }] }],
          count: 1,
          offset: 0,
          limit: 1,
        },
      });
    if (u.pathname === "/admin/notifications")
      return route.fulfill({ json: { notifications: [], count: 0, offset: 0, limit: 20 } });
    if (u.pathname === "/admin/profit-report/pnl") {
      const range = u.searchParams.get("range") || "month";
      seen.set(key, "fixture:" + range);
      return route.fulfill({ json: fixture[range] ?? fixture.month });
    }
    if (probe || u.pathname === "/admin/feature-flags") {
      const r = await route.fetch().catch(() => null);
      seen.set(key, r ? r.status() : "fail");
      return r ? route.fulfill({ response: r }) : route.abort();
    }
    seen.set(key, "stub");
    return route.fulfill({ json: {} });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  page.on(
    "console",
    (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)),
  );
  await page.goto(`${ADMIN}/pnl`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(6000);
  console.log("landed on", page.url());
  await page.screenshot({
    path: path.join(outDir, "pnl-month-1440.png"),
    fullPage: true,
  });
  if (!probe) {
    const all = page.getByRole("button", { name: /all time/i }).first();
    if (await all.count()) {
      await all.click();
      await page.waitForTimeout(2500);
      await page.screenshot({
        path: path.join(outDir, "pnl-all-1440.png"),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 2600 });
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: path.join(outDir, "pnl-month-390.png"),
      fullPage: true,
    });
  }
} finally {
  await browser.close();
  console.log("requests:");
  for (const [k, v] of seen) console.log(" ", v, k);
  console.log("errors:", errors.length ? errors.slice(0, 8) : "none");
}
