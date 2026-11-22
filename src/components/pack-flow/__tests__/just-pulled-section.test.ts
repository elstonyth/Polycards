import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RecentFeed, RecentPull } from '@/lib/data/packs';
import { DRAWER_GEOMETRY, DRAWER_MEDIA } from '../drawer-model';

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) =>
    createElement('img', { src, alt, loading: 'lazy' }),
}));

const { FlowJustPulled } = await import('../FlowJustPulled');

const pull = (i: number, extra: Partial<RecentPull> = {}): RecentPull => ({
  id: `p${i}`,
  handle: `card-${i}`,
  name: `Card ${i}`,
  image: `/img/${i}.webp`,
  slabImage: null,
  priceMyr: 10 + i,
  pokemonDex: null,
  spriteImage: null,
  rarity: i === 0 ? 'Legendary' : 'Common',
  packName: 'Delta Reign',
  packIcon: '/images/polycards/bronze-pack.webp',
  who: `Collector${i}`,
  profileHandle: i === 1 ? null : `collector-${i}`,
  avatar: null,
  frame: null,
  rolledAt: '2026-11-20T18:00:00.000Z',
  agoLabel: '4m ago',
  ...extra,
});
const pulls = [
  ...Array.from({ length: 11 }, (_, i) => pull(i)),
  pull(11, {
    tickets: 5,
    handle: 'tickets-5',
    name: '5 tickets',
    priceMyr: null,
  }),
];
const feed: RecentFeed = { pulls, drought: { Immortal: 1401, Legendary: 3 } };
const html = renderToStaticMarkup(createElement(FlowJustPulled, { feed }));
const src = (p: string) =>
  readFileSync(join(process.cwd(), 'src/components/pack-flow', p), 'utf8');
const at = (needle: string) => {
  const i = html.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

describe('Just Pulled on the server (the no-JavaScript form, and the drawer at rest)', () => {
  it('is the drawer alone: heading, counters, tier filter, then the pulls', () => {
    // the section's attribute comes from the list (FlowSections), not here
    expect(html).not.toContain('data-flow-section');
    expect(html.startsWith('<div data-jp')).toBe(true);
    const order = [
      'JUST PULLED',
      'data-jp-counter',
      'Filter pulls by tier',
      'data-jp-drawer',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('no longer carries the live ticker or Top Collectors', () => {
    const own = src('FlowJustPulled.tsx');
    expect(own).not.toMatch(/PullsMarquee|TheGame|topRippers/);
  });

  it('renders every pull as a card, in feed order, with its place in the stack', () => {
    const cards = [
      ...html.matchAll(/data-jp-card="" data-id="([^"]+)" data-d="(\d+)"/g),
    ];
    expect(cards.map((m) => m[1])).toEqual(pulls.map((p) => p.id));
    expect(cards.map((m) => Number(m[2]))).toEqual(pulls.map((_, i) => i));
    expect(html).not.toContain('data-arrive');
    expect(html).not.toContain('data-leave');
  });

  it("keeps today's words: heading, LIVE, the counters, the tabs, the card label", () => {
    for (const w of [
      'JUST PULLED',
      'LIVE',
      '1401',
      'packs without',
      'Immortal',
      'Legendary',
      'Mythical',
      'aria-label="Stats"',
    ])
      at(w);
    at('aria-label="Collector0 pulled Card 0 — Legendary, RM 10.00, 4m ago"');
    at('href="/card/card-0"');
    at('href="/profile/collector-0?tab=activity"');
    at('· Delta Reign');
    expect(html).not.toMatch(/published/i);
  });

  it('gives a ticket win no card link and no price, only its amount', () => {
    expect(html).not.toContain('href="/card/tickets-5"');
    at('5 tickets');
  });

  it('loads the drawer code lazily, never in the first load', () => {
    expect(src('FlowJustPulled.tsx')).not.toMatch(/JustPulledDrawer/);
    expect(src('JustPulledShell.tsx')).toMatch(
      /import\(\s*\/\* webpackChunkName: "jp-drawer" \*\/ '\.\/JustPulledDrawer'/,
    );
  });

  it('has no scroll or wheel listener and no fixed element of its own', () => {
    for (const f of [
      'FlowJustPulled.tsx',
      'JustPulledShell.tsx',
      'JustPulledDrawer.tsx',
      'JustPulledView.tsx',
      'drawer.module.css',
    ]) {
      const s = src(f);
      expect(s, f).not.toMatch(/['"](scroll|wheel|touchmove)['"]/);
      expect(s, f).not.toMatch(
        /position:\s*fixed|\bfixed\b(?=[^\n]*className)/,
      );
    }
  });

  it("draws the drawer at the model's size (drawer.module.css)", () => {
    const css = src('drawer.module.css');
    const { phone, desktop } = DRAWER_GEOMETRY;
    expect(css).toContain(`--card-h: ${phone.cardH}px;`);
    expect(css).toContain(`--tab-h: ${phone.tabH}px;`);
    expect(css).toContain(`--behind: ${phone.behind};`);
    expect(css).toContain(`--card-h: ${desktop.cardH}px;`);
    expect(css).toContain(`--tab-h: ${desktop.tabH}px;`);
    expect(css).toContain(`--behind: ${desktop.behind};`);
    // Each short-phone tier's numbers sit in its own media block, and the
    // tiny block's query is the one the drawer reads for its tab count.
    const block = (query: string) => {
      const at = css.indexOf(`@media ${query} {`);
      expect(at, query).toBeGreaterThan(-1);
      const end = css.indexOf('@media', at + 1);
      return css.slice(at, end < 0 ? undefined : end);
    };
    const { short, tiny } = DRAWER_GEOMETRY;
    const shortCss = block('(max-width: 1023px) and (max-height: 720px)');
    expect(shortCss).toContain(`--card-h: ${short.cardH}px;`);
    expect(shortCss).toContain(`--tab-h: ${short.tabH}px;`);
    expect(shortCss).not.toContain('--behind');
    const tinyCss = block(DRAWER_MEDIA.tiny);
    expect(tinyCss).toContain(`--card-h: ${tiny.cardH}px;`);
    expect(tinyCss).toContain(`--behind: ${tiny.behind};`);
    expect(css).toMatch(
      /height:\s*calc\(var\(--card-h\) \+ var\(--behind\) \* var\(--tab-h\)\)/,
    );
  });
});
