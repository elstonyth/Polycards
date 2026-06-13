import { firefox } from 'playwright';
// Headed = a real visible Firefox window on screen.
const browser = await firefox.launch({ headless: false });
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
console.log(
  'Firefox window opened at http://localhost:4000/ — leaving it open.',
);
// Keep the process (and window) alive until the user closes the window.
await new Promise((resolve) => {
  browser.on('disconnected', resolve);
});
