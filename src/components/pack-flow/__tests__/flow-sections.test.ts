import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RecentFeed } from '@/lib/data/packs';

// The client parts are stood in by markers: this checks the order the page
// renders, not their own markup (they have their own tests).
const marker = (name: string) =>
  function Marker() {
    return createElement('div', { 'data-mock': name });
  };
vi.mock('@/components/home/HeroFreePack', () => ({
  HeroFreePack: ({ promo }: { promo: boolean }) =>
    createElement('div', { 'data-mock': promo ? 'offer' : 'offer-off' }),
}));
vi.mock('@/components/home/PullsMarquee', () => ({
  default: marker('ticker'),
}));
vi.mock('@/components/home/TheGame', () => ({ default: marker('collectors') }));

const { FlowSections } = await import('../FlowSections');

const feed: RecentFeed = { pulls: [], drought: {} };
const html = renderToStaticMarkup(
  createElement(FlowSections, {
    feed,
    topRippers: [],
  }),
);
const at = (needle: string) => {
  const i = html.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

describe('the preview page below the stage', () => {
  it('runs Just Pulled, then Telegram with trust and footer', () => {
    const order = [
      'data-flow-section="just-pulled"',
      'data-jp-drawer',
      'data-mock="ticker"',
      'data-mock="collectors"',
      'data-flow-section="telegram"',
      'href="https://t.me/polycardsgg"',
      'WHY IT’S REAL',
      'data-site-chrome',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('carries exactly one site footer, inside the Telegram section', () => {
    expect(html.match(/<footer/g)?.length).toBe(1);
    expect(at('<footer')).toBeGreaterThan(at('data-flow-section="telegram"'));
  });

  it('drops the old closing banner', () => {
    expect(html).not.toContain('YOUR CHASE');
    expect(html).not.toContain('IS WAITING');
  });

  it('has no block between the lineup and Just Pulled: no free pack card, no ships and buyback line', () => {
    expect(html).not.toContain('data-flow-section="opening"');
    expect(html).not.toContain('data-mock="offer"');
    // the first section after the paged spacers is Just Pulled
    expect(html.indexOf('data-flow-section')).toBe(
      at('data-flow-section="just-pulled"'),
    );
  });

  it('puts the paged spacers before Just Pulled and Return and Last after the footer', () => {
    for (const s of ['row', 'band', 'lineup'])
      expect(at(`data-flow-spacer="${s}"`)).toBeLessThan(
        at('data-flow-section="just-pulled"'),
      );
    // no Exit spacer: the lineup exits over the Lineup spacer alone
    expect(html).not.toContain('data-flow-spacer="exit"');
    for (const s of ['return', 'last'])
      expect(at(`data-flow-spacer="${s}"`)).toBeGreaterThan(at('</footer>'));
  });
});
