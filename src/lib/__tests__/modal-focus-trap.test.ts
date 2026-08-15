// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, createElement, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useModalA11y } from '../use-modal-a11y';

// The Tab trap (WCAG 2.1.2). The case these pin: `document.activeElement` can
// be something the trap does not own — most commonly <body>, which the browser
// focuses whenever the currently-focused element becomes `disabled`. Any modal
// that disables its own action button mid-request lands there, and an
// enumerate-the-boundary-elements trap (active === first / last / panel) then
// matches nothing, so Tab walked straight out into the page behind the panel.
//
// Driven through createRoot + act rather than a testing library, matching the
// other component tests here (and note vitest only collects `*.test.ts`).

function Dialog({
  id,
  onClose = () => {},
}: {
  id: string;
  onClose?: () => void;
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  return createElement(
    'div',
    // Identical to JSX `ref={panelRef}`, but through createElement the React
    // Compiler lint cannot see that the ref is only read after commit and
    // reports a render-time access. A callback ref is flagged the same way.
    // eslint-disable-next-line react-hooks/refs
    { ref: panelRef, role: 'dialog', tabIndex: -1, id: `${id}-panel` },
    createElement('button', { type: 'button', id: `${id}-first` }, 'first'),
    createElement('button', { type: 'button', id: `${id}-last` }, 'last'),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Mounts one dialog per id; the LAST one is topmost (mount order = stack order). */
function mount(...ids: string[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(ids.map((id) => createElement(Dialog, { id, key: id })));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const el = (id: string) => document.getElementById(id) as HTMLElement;

function pressTab(shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(e);
  return e;
}

describe('useModalA11y focus trap', () => {
  it('pulls focus back in when Tab is pressed with focus outside the panel', () => {
    mount('d');
    // What the browser does when the focused control becomes disabled: it blurs
    // to <body>. Asserted as a precondition rather than driven through a
    // `disabled` re-render, so the test pins the trap and not jsdom's focus
    // emulation.
    el('d-last').focus();
    el('d-last').blur();
    expect(document.activeElement).toBe(document.body);

    const e = pressTab();

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(el('d-first'));
  });

  it('pulls focus back in on Shift+Tab from outside, landing on the last control', () => {
    mount('d');
    el('d-first').focus();
    el('d-first').blur();
    expect(document.activeElement).toBe(document.body);

    const e = pressTab(true);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(el('d-last'));
  });

  it('wraps at the end of the panel', () => {
    mount('d');
    el('d-last').focus();

    const e = pressTab();

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(el('d-first'));
  });

  it('wraps at the start of the panel on Shift+Tab', () => {
    mount('d');
    el('d-first').focus();

    const e = pressTab(true);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(el('d-last'));
  });

  it('wraps on Shift+Tab from the panel itself, which holds focus from open', () => {
    // The panel contains itself, so it reads as "inside" — this is the case a
    // pure containment check silently drops, and it is the first keypress after
    // every open.
    mount('d');
    expect(document.activeElement).toBe(el('d-panel'));

    const e = pressTab(true);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(el('d-last'));
  });

  it('leaves Tab between controls inside the panel to the browser', () => {
    mount('d');
    el('d-first').focus();

    const e = pressTab();

    // Not a boundary: preventing default here would break normal in-panel
    // traversal (jsdom does not move focus itself, so the assertion is on the
    // event, not on activeElement).
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(el('d-first'));
  });

  it('Escape calls the latest onClose, not the one from the render that opened', () => {
    // AuthModal leans on this: its Escape must see the CURRENT mode, because a
    // reactivate dismissal has to route through the logout path instead of
    // closing on a live session cookie. The hand-rolled trap it replaced got
    // that by listing `mode` in the effect deps, which tore the listener down
    // and bounced focus on every switch. Here the effect never re-runs, so if
    // the onClose ref ever stops being refreshed this silently regresses to the
    // stale callback.
    const calls: string[] = [];
    function Host({ label }: { label: string }) {
      const panelRef = useRef<HTMLDivElement>(null);
      useModalA11y(panelRef, true, () => calls.push(label));
      // eslint-disable-next-line react-hooks/refs
      return createElement('div', { ref: panelRef, tabIndex: -1 });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(Host, { label: 'opened-with' })));
    act(() => root.render(createElement(Host, { label: 'current' })));

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    expect(calls).toEqual(['current']);
  });

  it('a stacked dialog does not steal focus out of the overlay above it', () => {
    // Both panels register a document-level keydown listener, so the lower
    // one's trap also sees this Tab. Focus inside the top panel is "outside my
    // panel" from the lower panel's point of view — without the topmost gate it
    // would yank focus down out of the overlay the user is actually using.
    mount('bottom', 'top');
    el('top-first').focus();

    const e = pressTab(true);

    expect(document.activeElement).toBe(el('top-last'));
    expect(e.defaultPrevented).toBe(true);
  });
});
