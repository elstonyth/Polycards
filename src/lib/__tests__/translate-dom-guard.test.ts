// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

// The 2026-10-18 crash: a customer reading the site through Chrome's
// translation tapped "Confirm real name" in the real-name gate. React inserts
// the spinner before the button's label text node, which translation had
// already swapped out, and the whole account page fell to the error screen.

const saveRealName = vi.fn(() => new Promise(() => {}));
vi.mock('@/lib/actions/customer', () => ({
  saveRealName: (...a: unknown[]) => saveRealName(...(a as [])),
}));

import { RealNameEntry } from '@/components/account/RealNameEntry';
import { installTranslateDomGuard } from '../translate-dom-guard';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// What page translation does to the DOM: each text node is replaced by
// <font><font>translated</font></font>, detaching the node React holds.
function translatePage(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    if (!t.nodeValue?.trim()) continue;
    const outer = document.createElement('font');
    const inner = document.createElement('font');
    inner.textContent = `译 ${t.nodeValue}`;
    outer.appendChild(inner);
    t.parentNode!.replaceChild(outer, t);
  }
}

/** Renders the gate's entry, moves to the confirm step, translates the page,
 *  then taps Confirm. Resolves with what the tap threw, if anything. */
async function confirmUnderTranslation(): Promise<{
  thrown: unknown;
  container: HTMLDivElement;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(RealNameEntry, { onSaved: vi.fn() })));
  const input = container.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'Tan Ah Kow');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  translatePage(container);
  const confirm = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Confirm real name'),
  )!;
  let thrown: unknown = null;
  try {
    await act(async () => {
      confirm.click();
    });
  } catch (e) {
    thrown = e;
  }
  return { thrown, container };
}

// Order matters: the guard patches Node.prototype for the rest of the file.
describe('translate DOM guard', () => {
  it('reproduces the crash without the guard', async () => {
    const { thrown } = await confirmUnderTranslation();
    expect((thrown as Error | null)?.name).toBe('NotFoundError');
  });

  it('keeps the confirm tap working with the guard installed', async () => {
    installTranslateDomGuard();
    saveRealName.mockClear();
    const { thrown, container } = await confirmUnderTranslation();
    expect(thrown).toBeNull();
    expect(saveRealName).toHaveBeenCalledWith({ real_name: 'Tan Ah Kow' });
    // The spinner still rendered (appended, since its anchor moved).
    expect(container.querySelector('button svg')).not.toBeNull();
  });

  it('leaves normal inserts and removes untouched', () => {
    installTranslateDomGuard(); // idempotent
    const parent = document.createElement('div');
    const a = parent.appendChild(document.createElement('a'));
    const b = document.createElement('b');
    parent.insertBefore(b, a);
    expect([...parent.childNodes]).toEqual([b, a]);
    parent.removeChild(b);
    expect([...parent.childNodes]).toEqual([a]);
    // A node that is somewhere else entirely is still not removable from here,
    // but no longer throws.
    const stray = document.createElement('i');
    expect(parent.removeChild(stray)).toBe(stray);
  });
});
