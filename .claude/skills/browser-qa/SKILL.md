---
name: browser-qa
description: Use this skill to automate visual testing and UI interaction verification using browser automation after deploying features.
origin: ECC
---

# Browser QA — Automated Visual Testing & Interaction

## When to Use

- After deploying a feature to staging/preview
- When you need to verify UI behavior across pages
- Before shipping — confirm layouts, forms, interactions actually work
- When reviewing PRs that touch frontend code
- Accessibility audits and responsive testing

## How It Works

Drives the page with **one-off Playwright `scripts/*.mjs` capture scripts run against the
production build** (`npm run build` + `npx next start -p 4000`), screenshotting to
`docs/research/*.png` and reading those PNGs back with the Read tool. This is the repo's
QA convention (CLAUDE.md + `.claude/rules/web/testing.md`) — `next dev` serves images too
slowly to trust, and Chrome/preview MCP is explicitly **banned for verification** here.

### Phase 1: Smoke Test
```
1. Navigate to target URL
2. Check for console errors (filter noise: analytics, third-party)
3. Verify no 4xx/5xx in network requests
4. Screenshot above-the-fold on desktop + mobile viewport
5. Check Core Web Vitals: LCP < 2.5s, CLS < 0.1, INP < 200ms
```

### Phase 2: Interaction Test
```
1. Click every nav link — verify no dead links
2. Submit forms with valid data — verify success state
3. Submit forms with invalid data — verify error state
4. Test auth flow: login → protected page → logout
5. Test critical user journeys (checkout, onboarding, search)
```

### Phase 3: Visual Regression
```
1. Screenshot key pages at 3 breakpoints (375px, 768px, 1440px)
2. Compare against baseline screenshots (if stored)
3. Flag layout shifts > 5px, missing elements, overflow
4. Check dark mode if applicable
```

### Phase 4: Accessibility
```
1. Run axe-core or equivalent on each page
2. Flag WCAG AA violations (contrast, labels, focus order)
3. Verify keyboard navigation works end-to-end
4. Check screen reader landmarks
```

## Output Format

```markdown
## QA Report — [URL] — [timestamp]

### Smoke Test
- Console errors: 0 critical, 2 warnings (analytics noise)
- Network: all 200/304, no failures
- Core Web Vitals: LCP 1.2s ✓, CLS 0.02 ✓, INP 89ms ✓

### Interactions
- [✓] Nav links: 12/12 working
- [✗] Contact form: missing error state for invalid email
- [✓] Auth flow: login/logout working

### Visual
- [✗] Hero section overflows on 375px viewport
- [✓] Dark mode: all pages consistent

### Accessibility
- 2 AA violations: missing alt text on hero image, low contrast on footer links

### Verdict: SHIP WITH FIXES (2 issues, 0 blockers)
```

## Integration

Drive the browser with **Playwright `scripts/*.mjs`** captures against the prod build on
`:4000`, then read the resulting `docs/research/*.png` back with the Read tool. New checks
should add or extend a script (e.g. `qa-*.mjs`, `recon-*.mjs`) rather than reach for a
live-browser MCP — Chrome/preview MCP is banned for verification in this repo.

Pair with `/canary-watch` for post-deploy monitoring.
