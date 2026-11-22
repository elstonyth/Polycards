import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RecentFeed } from '@/lib/data/packs';

const feed: RecentFeed = { pulls: [], drought: {} };
const reads = vi.hoisted(() => ({ feed: 0 }));
vi.mock('@/lib/data/packs', () => ({
  getRecentPulls: async () => {
    reads.feed += 1;
    return { pulls: [], drought: {} };
  },
}));
vi.mock('@/lib/ttl-cache', () => ({
  cached: (_key: string, _ms: number, read: () => Promise<unknown>) => read(),
}));

const { FLOW_SECTIONS, FlowSections, flowSection, loadFlowData } =
  await import('../FlowSections');

const render = (sections = FLOW_SECTIONS) =>
  renderToStaticMarkup(
    createElement(FlowSections, { data: { feed }, sections }),
  );
const html = render();
const at = (needle: string, text = html) => {
  const i = text.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};
const ids = (text: string) =>
  [...text.matchAll(/data-flow-section="([^"]+)"/g)].map((m) => m[1]);

describe('the sections below the lineup are one list', () => {
  it('renders the listed sections in order, each wrapped in its id', () => {
    expect(ids(html)).toEqual(FLOW_SECTIONS.map((s) => s.id));
    expect(ids(html)).toEqual(['just-pulled']);
  });

  it('has unique kebab-case ids', () => {
    const list = FLOW_SECTIONS.map((s) => s.id);
    expect(new Set(list).size).toBe(list.length);
    for (const id of list) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it('puts the Just Pulled drawer straight inside its section', () => {
    expect(html).toMatch(/<div data-flow-section="just-pulled"><div data-jp/);
  });

  it('ends with Just Pulled and carries no site footer', () => {
    expect(html).not.toContain('<footer');
    expect(FLOW_SECTIONS[FLOW_SECTIONS.length - 1]?.id).toBe('just-pulled');
  });

  it('no longer carries the ticker, Top Collectors, the Telegram button or the trust points', () => {
    expect(html).not.toContain('game-heading');
    expect(html).not.toContain('trust-heading');
    expect(html).not.toMatch(/WHY IT.S REAL/);
    expect(html).not.toMatch(/Top Collectors/i);
    // and, with the footer gone, no Telegram link at all
    expect(html).not.toContain('https://t.me/polycardsgg');
    expect(html).not.toContain('YOUR CHASE');
  });

  it('puts the paged spacers before the first section and Return and Last after the last', () => {
    const first = at('data-flow-section=');
    for (const s of ['row', 'band', 'lineup'])
      expect(at(`data-flow-spacer="${s}"`)).toBeLessThan(first);
    expect(html).not.toContain('data-flow-spacer="exit"');
    const lastSection = html.lastIndexOf('data-flow-section=');
    for (const s of ['return', 'last'])
      expect(at(`data-flow-spacer="${s}"`)).toBeGreaterThan(lastSection);
  });

  it('takes a new section with one entry: the sections render in order between the spacers', () => {
    const extra = flowSection('new-part', [], () =>
      createElement('p', null, 'new part'),
    );
    const two = [FLOW_SECTIONS[0]!, extra];
    const out = render(two);
    expect(ids(out)).toEqual(['just-pulled', 'new-part']);
    expect(at('new part', out)).toBeGreaterThan(at('data-jp', out));
    expect(at('data-flow-spacer="return"', out)).toBeGreaterThan(
      at('new part', out),
    );
  });
});

describe('the page reads only what the listed sections need', () => {
  it('reads the feed once for the list', async () => {
    reads.feed = 0;
    const data = await loadFlowData();
    expect(reads.feed).toBe(1);
    expect(Object.keys(data)).toEqual(['feed']);
  });

  it('reads nothing for sections that need nothing', async () => {
    reads.feed = 0;
    const data = await loadFlowData([
      flowSection('static-part', [], () => null),
    ]);
    expect(reads.feed).toBe(0);
    expect(data).toEqual({});
  });

  it('the preview page reads no leaderboard and no feed of its own', () => {
    const page = readFileSync(
      join(process.cwd(), 'src/app/home-preview/page.tsx'),
      'utf8',
    );
    expect(page).not.toMatch(/leaderboard/i);
    expect(page).not.toContain('getRecentPulls');
    expect(page).toContain('loadFlowData()');
  });
});

describe('the stage never names a section', () => {
  const dir = join(process.cwd(), 'src/components/pack-stage');
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p);
      return /\.(ts|tsx|css)$/.test(n) ? [p] : [];
    });
  const NAMED = /data-flow-section\s*=\s*['"]/;

  it('the pattern catches a named section (positive control)', () => {
    expect(NAMED.test(`"[data-flow-section='telegram']"`)).toBe(true);
    expect(NAMED.test('[data-flow-section="just-pulled"]')).toBe(true);
    expect(NAMED.test("'[data-flow-section]'")).toBe(false);
  });

  it('no stage file selects a section by its id', () => {
    const files = walk(dir);
    expect(files.length).toBeGreaterThan(10);
    const hits = files.filter((f) => NAMED.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
