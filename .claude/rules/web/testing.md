> This file extends [common/testing.md](../common/testing.md) with web-specific testing content.

# Web Testing Rules

> **This repo:** QA is script-driven, not a test runner. The Playwright scripts
> in `scripts/*.mjs` (e.g. `recon-*`, `measure-*`, `qa-*`, `hover-audit*`)
> capture/measure the live site vs the clone and dump screenshots + JSON into
> `docs/research/`. **Verify against the production build** (`npm run build` +
> `npx next start -p 4000`), not `next dev` (slow image serving makes a correct
> build look broken). Read the PNGs back with the Read tool. See CLAUDE.md.

## Priority Order

### 1. Visual Regression

- Screenshot key breakpoints: 320, 768, 1024, 1440
- Test hero sections, scrollytelling sections, and meaningful states
- Use Playwright screenshots for visual-heavy work
- If both themes exist, test both

### 2. Accessibility

- Run automated accessibility checks
- Test keyboard navigation
- Verify reduced-motion behavior
- Verify color contrast

### 3. Performance

- Run Lighthouse or equivalent against meaningful pages
- Keep CWV targets from [performance.md](performance.md)

### 4. Cross-Browser

- Minimum: Chrome, Firefox, Safari
- Test scrolling, motion, and fallback behavior

### 5. Responsive

- Test 320, 375, 768, 1024, 1440, 1920
- Verify no overflow
- Verify touch interactions

## E2E Shape

```ts
import { test, expect } from '@playwright/test';

test('landing hero loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
});
```

- Avoid flaky timeout-based assertions
- Prefer deterministic waits

## Unit Tests

- Test utilities, data transforms, and custom hooks
- For highly visual components, visual regression often carries more signal than brittle markup assertions
- Visual regression supplements coverage targets; it does not replace them
