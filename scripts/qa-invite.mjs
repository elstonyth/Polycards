import { chromium } from 'playwright';
const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const browser = await chromium.launch();
for (const [path, name] of [
  ['/invite/demo-wozs', 'invite-valid'],
  ['/invite/ghost-nobody-999', 'invite-unknown'],
]) {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  const rej = page.getByRole('button', { name: /reject/i });
  if (await rej.count())
    await rej
      .first()
      .click({ force: true })
      .catch(() => {});
  await page.waitForTimeout(2500);
  const txt = await page.locator('body').innerText();
  console.log(
    name,
    '| url:',
    new URL(page.url()).search || '(cleaned)',
    '| signupOpen:',
    txt.includes('Create your account') ||
      txt.includes('Join Polycards') ||
      txt.includes('Sign up'),
    '| banner:',
    txt
      .split('\n')
      .filter((l) =>
        /invited you|already have an account|isn't valid/i.test(l),
      )[0] ?? 'NONE',
  );
  await page.screenshot({ path: `docs/research/${name}.png`, fullPage: false });
  await page.close();
}
await browser.close();
