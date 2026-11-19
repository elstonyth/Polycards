// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageLanguageCut, StageShelf } from '../contract';
import StageChips from '../StageChips';
import { nextFocusIndex } from '../StageSortPanel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const shelf = (
  key: string,
  label: string,
  caption: string | null,
): StageShelf => ({ key, label, caption, count: 1, ids: [key], languages: [] });

const SHELVES = [
  shelf('all', 'All', null),
  shelf('classic', 'Classic', 'Graded'),
  shelf('original', 'Original', 'Raw Cards'),
  shelf('special', 'Special', 'Graded'),
];
const LANGS: StageLanguageCut[] = [
  { key: 'en', label: 'English', short: 'EN', ids: [] },
  { key: 'jp', label: 'Japanese', short: 'JP', ids: [] },
];

let host: HTMLDivElement;
let root: Root;
const onPick = vi.fn();
const withLangs = (s: StageShelf[]) =>
  s.map((x, i) => (i === 0 ? { ...x, languages: LANGS } : x));

type Over = Partial<Parameters<typeof StageChips>[0]> & {
  shelves?: StageShelf[];
  shelf?: string;
  language?: string | null;
};

function render(over: Over = {}) {
  const { shelves = SHELVES, shelf = 'all', language = null, ...rest } = over;
  act(() => {
    root.render(
      createElement(StageChips, {
        category: { shelves },
        filter: { shelf, language },
        label: 'All packs',
        off: false,
        onPick,
        ...rest,
      }),
    );
  });
}

const trigger = () =>
  host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
const panel = () =>
  host.querySelector<HTMLElement>('[role="group"][aria-label="Pack type"]')!;
const button = (text: RegExp) =>
  [...panel().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    text.test(b.textContent ?? ''),
  )!;
const click = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
/** The panel's contents arrive in their own chunk: let it load and render. */
const settle = () =>
  act(async () => {
    await import('../StageSortPanel');
    await new Promise((r) => setTimeout(r, 0));
  });
const openPanel = async () => {
  click(trigger());
  await settle();
};
const escape = () =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onPick.mockReset();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('StageChips: the closed tab', () => {
  it('is collapsed by default, names the current choice, and is all the first load holds', () => {
    render();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().textContent).toBe('Pack type: All packs');
    expect(trigger().getAttribute('aria-controls')).toBe(panel().id);
    expect(panel().hasAttribute('data-open')).toBe(false);
    expect(panel().hasAttribute('inert')).toBe(true);
    // The chips are not rendered until the panel's chunk is wanted.
    expect(panel().querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the chosen type (and language) on the tab', () => {
    render({ shelf: 'classic', label: 'Classic · Graded · Japanese' });
    expect(trigger().textContent).toBe(
      'Pack type: Classic · Graded · Japanese',
    );
  });

  it('loads the panel on the first intent (hover) without opening it', async () => {
    render();
    act(() => {
      trigger().dispatchEvent(new Event('pointerover', { bubbles: true }));
    });
    act(() => {
      trigger().focus();
    });
    await settle();
    expect(panel().querySelectorAll('button').length).toBeGreaterThan(0);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(panel().hasAttribute('data-open')).toBe(false);
  });
});

describe('StageChips: the panel', () => {
  it('opens on a tap with "All" first, captions on the chips, focus on the current choice', async () => {
    render({ shelf: 'original', label: 'Original · Raw Cards' });
    await openPanel();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panel().hasAttribute('data-open')).toBe(true);
    expect(panel().hasAttribute('inert')).toBe(false);
    const labels = [...panel().querySelectorAll('button')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual([
      'All',
      'ClassicGraded',
      'OriginalRaw Cards',
      'SpecialGraded',
    ]);
    expect(document.activeElement).toBe(button(/^Original/));
    expect(button(/^Original/).getAttribute('aria-pressed')).toBe('true');
  });

  it('closes on Escape and gives focus back to the tab', async () => {
    render();
    await openPanel();
    escape();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a tap outside', async () => {
    render();
    await openPanel();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    outside.remove();
  });

  it('moves focus with the arrow keys', async () => {
    render();
    await openPanel();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight' }),
      );
    });
    expect(document.activeElement).toBe(button(/^Classic/));
  });

  it('a choice closes the panel, returns focus, then changes the row', async () => {
    render();
    await openPanel();
    click(button(/^Classic/));
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
    expect(onPick).toHaveBeenCalledWith({ shelf: 'classic', language: null });
  });

  it('"All" stays first and undoes a choice', async () => {
    render({ shelf: 'special', label: 'Special · Graded' });
    await openPanel();
    expect(panel().querySelector('button')?.textContent).toBe('All');
    click(button(/^All/));
    expect(onPick).toHaveBeenCalledWith({ shelf: 'all', language: null });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('holds the Language group inside the panel only when languages apply', async () => {
    render();
    await openPanel();
    expect(panel().querySelector('[aria-label="Language"]')).toBeNull();
    render({ shelves: withLangs(SHELVES), language: 'jp' });
    const group = panel().querySelector(
      '[role="group"][aria-label="Language"]',
    )!;
    const names = [...group.querySelectorAll('button')].map((b) => [
      b.textContent,
      b.getAttribute('aria-pressed'),
    ]);
    expect(names).toEqual([
      ['English', 'false'],
      ['Japanese', 'true'],
    ]);
    click(group.querySelector<HTMLButtonElement>('button')!);
    expect(onPick).toHaveBeenCalledWith({ shelf: 'all', language: 'en' });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows no tab to anyone for a category with no choices (off)', async () => {
    render({ off: true });
    const row = host.querySelector<HTMLElement>('[data-stage-chips]')!;
    expect(row.getAttribute('aria-hidden')).toBe('true');
    expect(row.hasAttribute('inert')).toBe(true);
    await openPanel();
    expect(panel().hasAttribute('data-open')).toBe(false);
  });

  it('renders nothing with neither type chips nor languages', () => {
    render({ shelves: [shelf('all', 'All', null)] });
    expect(host.innerHTML).toBe('');
  });
});

describe('nextFocusIndex: arrows move through the panel, wrapping', () => {
  it('moves and wraps', () => {
    expect(nextFocusIndex('ArrowRight', 0, 4)).toBe(1);
    expect(nextFocusIndex('ArrowDown', 3, 4)).toBe(0);
    expect(nextFocusIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(nextFocusIndex('ArrowUp', 2, 4)).toBe(1);
    expect(nextFocusIndex('Home', 2, 4)).toBe(0);
    expect(nextFocusIndex('End', 0, 4)).toBe(3);
    expect(nextFocusIndex('Tab', 0, 4)).toBeNull();
    expect(nextFocusIndex('ArrowRight', -1, 4)).toBe(0);
  });
});

describe('the panel never takes room', () => {
  it('is absolutely positioned over the stage, with CSS-only motion', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/components/pack-stage/pack-stage.module.css'),
      'utf8',
    );
    const menu = /\.growPanel\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(menu).toMatch(/position:\s*absolute/);
    expect(menu).toMatch(/transition:/);
    expect(menu).toMatch(/visibility:\s*hidden/);
  });
});
