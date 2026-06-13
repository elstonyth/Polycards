import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
// QA: 3 visible cards, glow follows center, full width, 0 broken
const r = await p.evaluate(() => {
  const slots = [
    ...document.querySelectorAll(
      "a[href='/claw'] > div:last-child div.absolute.inset-0 > div",
    ),
  ];
  const vis = slots.filter((s) => +getComputedStyle(s).opacity > 0.05).length;
  const broken = [...document.images].filter(
    (x) => x.complete && x.naturalWidth === 0,
  ).length;
  const hero = document
    .querySelector("a[href='/claw']")
    .getBoundingClientRect();
  // active glow color
  const glows = [
    ...document.querySelectorAll("a[href='/claw'] > div[aria-hidden]"),
  ].filter((d) => d.style.background && +getComputedStyle(d).opacity > 0.5);
  const glow = glows[0]
    ? glows[0].style.background.match(/rgba\(([^)]+)\)/)?.[1]
    : 'none';
  return {
    visibleCards: vis,
    broken,
    heroW: Math.round(hero.width),
    heroH: Math.round(hero.height),
    glow,
  };
});
console.log(JSON.stringify(r));
await p.screenshot({
  path: 'docs/research/SKILL_HERO.png',
  clip: { x: 0, y: 56, width: 1920, height: 520 },
});
await b.close();
