import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// The admin suite is logic-only (no DOM render harness), so we lock the
// tab-buffer fix with a static source check: the seed-once edit buffers survive
// a tab switch only because the Tabs.Content entries are forceMount-ed. A
// refactor that silently drops forceMount would re-introduce the silent
// edit-wipe — this test fails if a named panel loses the prop.
//
// Match the <Tabs.Content …> opening tag itself: a bare /forceMount/ scan also
// hits the explanatory comments above the panels, which would stay green after
// a real panel lost the prop.
const forceMounts = (src: string, value: string) =>
  new RegExp(
    `<Tabs\\.Content\\b(?=[^>]*\\bvalue="${value}")(?=[^>]*\\bforceMount\\b)[^>]*>`,
  ).test(src);

const read = (...seg: string[]) => readFileSync(join(__dirname, ...seg), 'utf8');

describe('challenge/VIP tab buffers survive tab switches', () => {
  it('challenge page forceMounts both tab contents', () => {
    const src = read('page.tsx');
    expect(forceMounts(src, 'stages')).toBe(true);
    expect(forceMounts(src, 'payout')).toBe(true);
  });

  it('daily-rewards page forceMounts its buffer-holding tabs', () => {
    const src = read('..', 'daily-rewards', 'page.tsx');
    expect(forceMounts(src, 'levels')).toBe(true);
    expect(forceMounts(src, 'frames')).toBe(true);
    expect(forceMounts(src, 'settings')).toBe(true);
    // boxes is deliberately excluded — it has its own "Discard changes?" prompt
    // on tab switch, which forceMounting would make lie.
    expect(forceMounts(src, 'boxes')).toBe(false);
  });
});
