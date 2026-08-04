import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// The admin suite is logic-only (no DOM render harness), so we lock the
// tab-buffer fix with a static source check: the seed-once edit buffers survive
// a tab switch only because the Tabs.Content entries are forceMount-ed. A
// refactor that silently drops forceMount would re-introduce the silent
// edit-wipe — this test fails if a named panel loses the prop, OR if it keeps
// the prop but loses the className that hides it while inactive.
//
// Match the <Tabs.Content …> opening tag itself: a bare /forceMount/ scan also
// hits the explanatory comments above the panels, which would stay green after
// a real panel lost the prop.
const contentTag = (src: string, value: string): string | null =>
  new RegExp(
    String.raw`<Tabs\.Content\b(?=[^>]*\bvalue="${value}")[^>]*>`,
  ).exec(src)?.[0] ?? null;

const forceMounts = (src: string, value: string) => {
  const tag = contentTag(src, value);
  return tag !== null && /\bforceMount\b/.test(tag);
};

// forceMount is only half the contract. A mounted-but-INACTIVE panel must also
// be hidden, or every panel renders at once — asserting that separately means a
// refactor that keeps forceMount and drops the className fails here instead of
// staying green.
const hidesWhenInactive = (src: string, value: string) => {
  const tag = contentTag(src, value);
  return (
    tag !== null &&
    new RegExp(String.raw`className=\{[^}]*\b${value}\b[^}]*'hidden'`).test(tag)
  );
};

const read = (...seg: string[]) =>
  readFileSync(join(__dirname, ...seg), 'utf8');

describe('challenge/VIP tab buffers survive tab switches', () => {
  it('challenge page forceMounts every tab content and hides the inactive ones', () => {
    const src = read('page.tsx');
    // 'schedule' holds a buffer too: the Add-weekly-challenge draft lives in
    // ScheduleTab's subtree, so unmounting it on a tab switch would wipe it.
    for (const value of ['stages', 'schedule', 'payout']) {
      expect(forceMounts(src, value)).toBe(true);
      expect(hidesWhenInactive(src, value)).toBe(true);
    }
    // 'winners' is deliberately excluded — read-only history with no edit
    // buffer, so forceMounting it would only fire its query on every visit to
    // the page. Asserted as a NEGATIVE (same precedent as daily-rewards'
    // 'boxes') so adding it back to the loop above fails here first.
    expect(forceMounts(src, 'winners')).toBe(false);
    expect(hidesWhenInactive(src, 'winners')).toBe(false);
  });

  it('daily-rewards page forceMounts its buffer-holding tabs and hides them when inactive', () => {
    const src = read('..', 'daily-rewards', 'page.tsx');
    for (const value of ['levels', 'frames', 'settings']) {
      expect(forceMounts(src, value)).toBe(true);
      expect(hidesWhenInactive(src, value)).toBe(true);
    }
    // boxes is deliberately excluded — it has its own "Discard changes?" prompt
    // on tab switch, which forceMounting would make lie.
    expect(forceMounts(src, 'boxes')).toBe(false);
    expect(hidesWhenInactive(src, 'boxes')).toBe(false);
  });
});
