// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A load onto a pack's own address keeps the loader's cover up until the
// flow has placed the pack on its stop, and gives up to today's pack page
// at its own limit; a plain load keeps its usual cap.

const goToPackPage = vi.fn();
vi.mock('../stage-entry-cover', async (orig) => ({
  ...(await orig<typeof import('../stage-entry-cover')>()),
  goToPackPage,
}));

const { default: StageLoader } = await import('../StageLoader');
const {
  ENTRY_LEAVE_LIFT_MS,
  ENTRY_LOADER_MAX_MS,
  FLOW_ENTRY_ATTR,
  FLOW_HELD_ATTR,
  FLOW_LEAVE_ATTR,
  HOME_LOADER_MAX_MS,
  STAGE_LOADER_ATTR,
  flowEntryScript,
} = await import('../stage-loader-script');

const html = document.documentElement;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const mount = () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(createElement(StageLoader));
  });
};
/** Moves the clock (timers and performance.now) on in 50 ms steps, so timers
 *  set by the renders a step causes run too. */
const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 50)
    await act(async () => {
      vi.advanceTimersByTime(Math.min(50, ms - t));
    });
};
const coverUp = () => html.hasAttribute(STAGE_LOADER_ATTR);
/** Hides or shows the tab, as the browser does (the event included). */
const setHidden = async (hidden: boolean, event = true) => {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  if (event)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
  });
  goToPackPage.mockClear();
  html.setAttribute(STAGE_LOADER_ATTR, '1');
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  html.removeAttribute(STAGE_LOADER_ATTR);
  html.removeAttribute(FLOW_ENTRY_ATTR);
  html.removeAttribute(FLOW_LEAVE_ATTR);
  html.removeAttribute(FLOW_HELD_ATTR);
  delete (document as { hidden?: boolean }).hidden;
  vi.useRealTimers();
});

describe('the stage loader on a plain load', () => {
  it('lets go by its usual cap', async () => {
    mount();
    await advance(HOME_LOADER_MAX_MS + 2000);
    expect(coverUp()).toBe(false);
    expect(goToPackPage).not.toHaveBeenCalled();
  });

  it('keeps the CSS failsafe on', async () => {
    mount();
    await advance(500);
    expect(html.hasAttribute(FLOW_HELD_ATTR)).toBe(false);
  });
});

describe("the stage loader on a load onto a pack's address", () => {
  beforeEach(() => html.setAttribute(FLOW_ENTRY_ATTR, '151'));

  it('stays up past its usual cap while the pack is not placed', async () => {
    mount();
    await advance(ENTRY_LOADER_MAX_MS - 500);
    expect(coverUp()).toBe(true);
    expect(goToPackPage).not.toHaveBeenCalled();
  });

  it('lets go once the pack is placed on its stop', async () => {
    mount();
    await advance(6000);
    expect(coverUp()).toBe(true);
    await act(async () => html.removeAttribute(FLOW_ENTRY_ATTR));
    await advance(2000);
    expect(coverUp()).toBe(false);
    expect(goToPackPage).not.toHaveBeenCalled();
  });

  it("goes to today's pack page at its own limit, the cover still up", async () => {
    mount();
    await advance(ENTRY_LOADER_MAX_MS + 100);
    expect(goToPackPage).toHaveBeenCalledWith('151');
    expect(coverUp()).toBe(true);
  });

  it("once it has gone for today's pack page, the cover stays even if the pack is placed meanwhile", async () => {
    mount();
    await advance(ENTRY_LOADER_MAX_MS + 100);
    expect(goToPackPage).toHaveBeenCalledWith('151');
    await act(async () => html.removeAttribute(FLOW_ENTRY_ATTR));
    await advance(3000);
    expect(coverUp()).toBe(true);
    expect(html.hasAttribute(FLOW_LEAVE_ATTR)).toBe(true);
  });

  it('the limit keeps the exit fade of a pack placed just before it', async () => {
    mount();
    await advance(ENTRY_LOADER_MAX_MS - 200);
    await act(async () => html.removeAttribute(FLOW_ENTRY_ATTR));
    // past the limit, inside the 400 ms fade
    await advance(250);
    expect(coverUp()).toBe(true);
    await advance(500);
    expect(coverUp()).toBe(false);
    expect(goToPackPage).not.toHaveBeenCalled();
  });

  it("lifts the cover a while after going for today's pack page when that page never comes", async () => {
    mount();
    await advance(ENTRY_LOADER_MAX_MS + 100);
    expect(goToPackPage).toHaveBeenCalledWith('151');
    await advance(3000);
    expect(coverUp()).toBe(true);
    await advance(ENTRY_LEAVE_LIFT_MS);
    expect(coverUp()).toBe(false);
    expect(html.hasAttribute(FLOW_LEAVE_ATTR)).toBe(false);
  });

  it('a page that hydrates late still keeps the cover until the pack is placed', async () => {
    vi.advanceTimersByTime(HOME_LOADER_MAX_MS + 1000);
    mount();
    await advance(1000);
    expect(coverUp()).toBe(true);
    await act(async () => html.removeAttribute(FLOW_ENTRY_ATTR));
    await advance(2000);
    expect(coverUp()).toBe(false);
  });
});

describe("a load onto a pack's address in a background tab", () => {
  beforeEach(() => html.setAttribute(FLOW_ENTRY_ATTR, '151'));

  it('runs no limit while hidden, and places the pack once brought forward', async () => {
    await setHidden(true, false);
    mount();
    await advance(ENTRY_LOADER_MAX_MS + 5000);
    expect(goToPackPage).not.toHaveBeenCalled();
    expect(coverUp()).toBe(true);
    await setHidden(false);
    // the full budget again from here
    await advance(ENTRY_LOADER_MAX_MS - 500);
    expect(goToPackPage).not.toHaveBeenCalled();
    await act(async () => html.removeAttribute(FLOW_ENTRY_ATTR));
    await advance(2000);
    expect(coverUp()).toBe(false);
    expect(goToPackPage).not.toHaveBeenCalled();
  });

  it("brought forward and still not placed: today's pack page a full limit later", async () => {
    await setHidden(true, false);
    mount();
    await advance(30_000);
    await setHidden(false);
    await advance(ENTRY_LOADER_MAX_MS + 100);
    expect(goToPackPage).toHaveBeenCalledWith('151');
  });

  it('a tab hidden while it waits pauses the limit', async () => {
    mount();
    await advance(5000);
    await setHidden(true);
    await advance(30_000);
    expect(goToPackPage).not.toHaveBeenCalled();
    await setHidden(false);
    await advance(ENTRY_LOADER_MAX_MS - 500);
    expect(goToPackPage).not.toHaveBeenCalled();
    await advance(600);
    expect(goToPackPage).toHaveBeenCalledWith('151');
  });

  it('once hydrated, turns the CSS failsafe off, so a tab brought forward after it is still covered', async () => {
    await setHidden(true, false);
    mount();
    expect(html.hasAttribute(FLOW_HELD_ATTR)).toBe(true);
    await advance(20_000);
    await setHidden(false);
    expect(coverUp()).toBe(true);
    expect(html.hasAttribute(FLOW_HELD_ATTR)).toBe(true);
    // the cover's end drops the mark with it
    await act(async () => html.removeAttribute(FLOW_ENTRY_ATTR));
    await advance(2000);
    expect(coverUp()).toBe(false);
    expect(html.hasAttribute(FLOW_HELD_ATTR)).toBe(false);
  });
});

describe('the failsafe on such a load', () => {
  const css = () =>
    readFileSync(
      join(process.cwd(), 'src/components/pack-stage/pack-stage.module.css'),
      'utf8',
    );

  it("hides the cover with no script only a second after the entry's limit, keyed on a mark the placement never removes", () => {
    const rule =
      /:global\(html\[data-flow-cover\]\) \.shell,\s*:global\(html\[data-flow-cover\]\) \.stage \{\s*--stage-failsafe: ([\d.]+)s;/.exec(
        css(),
      );
    expect(Number(rule?.[1]) * 1000).toBe(ENTRY_LOADER_MAX_MS + 1000);
    expect(css()).not.toContain('html[data-flow-entry])');
  });

  it('is off once the page has hydrated: the rule comes after the shell rule that starts it', () => {
    const c = css();
    const held = c.search(
      /:global\(html\[data-flow-held\]\) \.shell \{\s*animation: none;/,
    );
    const shell = c.indexOf(':global(html[data-stage-loader]) .shell {');
    expect(shell).toBeGreaterThan(-1);
    expect(held).toBeGreaterThan(shell);
  });

  it('stays on with no script: only the hydrated page sets the mark', () => {
    expect(flowEntryScript('151', '/slots/151')).not.toContain(FLOW_HELD_ATTR);
  });

  it("never hides the cover while it goes to today's pack page", () => {
    expect(css()).toMatch(
      /:global\(html\[data-flow-leave\]\) \.shell \{\s*animation: none;/,
    );
  });
});
