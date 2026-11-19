import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolvedPack } from '@/lib/packs-data';
import { PACK_151_PRINT } from './pack-151-print';
import {
  BUYBACK_RULE,
  buybackHeadline,
  packBackDetails,
} from './pack-back-details';
import {
  buybackParagraph,
  layoutPackPrint,
  textToTexture,
  zoneInTextSpace,
  type MeasureText,
  type PackBackDetails,
  type PrintLayout,
  type PrintRun,
} from './pack-print';

const W = 897;
const H = 1666;

// Geist-like proportions: about 0.42 em a glyph, 0.25 em a space.
const measure: MeasureText = (text, font) =>
  Array.from(text).reduce(
    (w, ch) => w + (ch === ' ' ? 0.25 : 0.42) * font.size,
    0,
  );

const DETAILS_151: PackBackDetails = {
  price: 'RM 40.00',
  productLine: ['151', 'Pokémon', 'Original', 'English', 'Raw Cards'],
  odds: [
    { label: 'Immortal', chance: '0.1%' },
    { label: 'Legendary', chance: '1.4%' },
    { label: 'Mythical', chance: '3.5%' },
    { label: 'Rare', chance: '22%' },
    { label: 'Uncommon', chance: '30%' },
    { label: 'Common', chance: '43%' },
  ],
  buyback: {
    headline: '90% instant buyback',
    rule: 'The pack rate applies during the reveal countdown. Leaving the reveal or letting the timer expire changes buyback to 90% of card value in your vault.',
  },
};

const zoneOf = (run: PrintRun): keyof PrintLayout['zones'] =>
  run.role === 'buyback'
    ? 'buyback'
    : run.role.startsWith('odds')
      ? 'odds'
      : 'headline';

/** Every run's box (advance along u, ascent/descent down v) inside its zone. */
function expectInsideZones(layout: PrintLayout) {
  for (const run of layout.runs) {
    const z = layout.zones[zoneOf(run)];
    const u0 = run.align === 'right' ? run.x - run.width : run.x;
    const u1 = u0 + run.width;
    const top = run.y - 0.75 * run.font.size;
    const bottom = run.y + 0.22 * run.font.size;
    expect(u0, run.text).toBeGreaterThanOrEqual(z.u0 - 0.5);
    expect(u1, run.text).toBeLessThanOrEqual(z.u1 + 0.5);
    expect(top, run.text).toBeGreaterThanOrEqual(z.v0 - 0.5);
    expect(bottom, run.text).toBeLessThanOrEqual(z.v1 + 0.5);
  }
}

const byRole = (layout: PrintLayout, role: PrintRun['role']) =>
  layout.runs.filter((r) => r.role === role);

const odds = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    label: `Tier ${i + 1}`,
    chance: `${i + 1}%`,
  }));

describe('pack print layout', () => {
  const layout = layoutPackPrint(DETAILS_151, PACK_151_PRINT, W, H, measure);

  it('places the 151 details where the approved back prints them, inside the zones', () => {
    expect(byRole(layout, 'price')).toHaveLength(1);
    expect(byRole(layout, 'productLine')[0]?.text).toBe(
      '151 · Pokémon · Original · English · Raw Cards',
    );
    expect(byRole(layout, 'productLine')[0]?.font.size).toBeCloseTo(29.05, 5);
    expect(byRole(layout, 'oddsLabel')).toHaveLength(6);
    expect(byRole(layout, 'oddsValue')).toHaveLength(6);
    expect(byRole(layout, 'buyback').length).toBeGreaterThanOrEqual(3);
    expect(layout.plate).toBe('live');
    expectInsideZones(layout);
  });

  it('fills the odds column by column, three rows a column, values right-aligned', () => {
    const labels = byRole(layout, 'oddsLabel');
    const values = byRole(layout, 'oddsValue');
    expect(labels.map((r) => r.text)).toEqual(
      DETAILS_151.odds?.map((o) => o.label),
    );
    const [c1, c2] = PACK_151_PRINT.odds.columns;
    expect(labels.slice(0, 3).every((r) => r.x === c1?.labelX)).toBe(true);
    expect(labels.slice(3).every((r) => r.x === c2?.labelX)).toBe(true);
    expect(labels.slice(0, 3).map((r) => r.y)).toEqual([749.5, 783, 816.5]);
    expect(values.every((r) => r.align === 'right')).toBe(true);
  });

  it('reads bottom to top: a line runs up the texture, the stack runs right', () => {
    const run = byRole(layout, 'price')[0];
    if (!run) throw new Error('no price run');
    const start = textToTexture(H, run.x, run.y);
    const end = textToTexture(H, run.x + run.width, run.y);
    expect(end.y).toBeLessThan(start.y); // later glyphs sit higher on the texture
    expect(end.x).toBe(start.x); // one baseline = one texture column
    const line = byRole(layout, 'productLine')[0];
    expect(textToTexture(H, line?.x ?? 0, line?.y ?? 0).x).toBeGreaterThan(
      start.x,
    ); // next line to the right
    // a zone maps back onto its texture rectangle
    const z = zoneInTextSpace(PACK_151_PRINT.zones.odds, W, H);
    expect(textToTexture(H, z.u1, z.v0)).toEqual({
      x: W * PACK_151_PRINT.zones.odds.x0,
      y: H * PACK_151_PRINT.zones.odds.y0,
    });
  });

  it('handles fewer than six odds rows', () => {
    const five = layoutPackPrint(
      { ...DETAILS_151, odds: odds(5) },
      PACK_151_PRINT,
      W,
      H,
      measure,
    );
    const labels = byRole(five, 'oddsLabel');
    expect(
      labels.filter((r) => r.x === PACK_151_PRINT.odds.columns[0]?.labelX),
    ).toHaveLength(3);
    expect(
      labels.filter((r) => r.x === PACK_151_PRINT.odds.columns[1]?.labelX),
    ).toHaveLength(2);
    const two = layoutPackPrint(
      { ...DETAILS_151, odds: odds(2) },
      PACK_151_PRINT,
      W,
      H,
      measure,
    );
    expect(new Set(byRole(two, 'oddsLabel').map((r) => r.y)).size).toBe(1); // one row, two columns
    expectInsideZones(five);
    expectInsideZones(two);
  });

  it('handles more than six odds rows by tightening rows and type together', () => {
    const eight = layoutPackPrint(
      { ...DETAILS_151, odds: odds(8) },
      PACK_151_PRINT,
      W,
      H,
      measure,
    );
    const labels = byRole(eight, 'oddsLabel');
    expect(labels).toHaveLength(8);
    expect(Math.max(...labels.map((r) => r.y))).toBeLessThanOrEqual(
      PACK_151_PRINT.odds.lastBaseline + 1e-9,
    );
    expect(labels[0]?.font.size).toBeLessThan(PACK_151_PRINT.odds.font.size);
    expectInsideZones(eight);
  });

  it('prints no odds, and asks for the no-odds plate, when a pack publishes none', () => {
    for (const none of [null, []]) {
      const l = layoutPackPrint(
        { ...DETAILS_151, odds: none },
        PACK_151_PRINT,
        W,
        H,
        measure,
      );
      expect(byRole(l, 'oddsLabel')).toHaveLength(0);
      expect(byRole(l, 'oddsValue')).toHaveLength(0);
      expect(l.plate).toBe('no-odds');
    }
  });

  it('keeps long text inside its zone', () => {
    const long = layoutPackPrint(
      {
        price: 'RM 12,345.67',
        productLine: [
          'Scarlet & Violet Prismatic Evolutions',
          'Pokémon',
          'Original',
          'Japanese',
          'Raw Cards',
        ],
        odds: [{ label: 'Legendary', chance: '12.345%' }],
        buyback: {
          headline: '100% instant buyback',
          rule: `${DETAILS_151.buyback?.rule} ${DETAILS_151.buyback?.rule}`,
        },
      },
      PACK_151_PRINT,
      W,
      H,
      measure,
    );
    expectInsideZones(long);
    expect(
      byRole(long, 'productLine')[0]?.text.startsWith('Scarlet & Violet'),
    ).toBe(true);
  });

  it('scales with the texture', () => {
    const big = layoutPackPrint(
      DETAILS_151,
      PACK_151_PRINT,
      W * 2,
      H * 2,
      measure,
    );
    const a = byRole(layout, 'price')[0];
    const b = byRole(big, 'price')[0];
    expect(b?.x).toBeCloseTo((a?.x ?? 0) * 2, 6);
    expect(b?.y).toBeCloseTo((a?.y ?? 0) * 2, 6);
    expect(b?.font.size).toBeCloseTo((a?.font.size ?? 0) * 2, 6);
    expect(big.ink.softness).toBeCloseTo(layout.ink.softness * 2, 6);
  });

  it('joins the buyback headline and rule as one sentence run', () => {
    expect(
      buybackParagraph({ headline: '90% instant buyback', rule: 'Rule.' }),
    ).toBe('90% instant buyback. Rule.');
    expect(buybackParagraph({ headline: 'Sell back!', rule: 'Rule.' })).toBe(
      'Sell back! Rule.',
    );
  });
});

describe('pack back details (from the pack page data)', () => {
  const pack151: ResolvedPack = {
    id: '151',
    name: '151',
    priceMyr: 40,
    image: '/x.webp',
    categoryId: 'pokemon',
    categoryName: 'Pokémon',
    icon: '/i.webp',
    packType: 'original',
    language: 'en',
    group: 'RAW',
    psa10: false,
  };
  const published = {
    tiers: {
      Immortal: 0.1,
      Legendary: 1.4,
      Mythical: 3.5,
      Rare: 22,
      Uncommon: 30,
      Common: 43,
    },
  };

  it('maps 151 to exactly what the approved back prints', () => {
    expect(packBackDetails(pack151, published)).toEqual(DETAILS_151);
  });

  it('follows the instant rate into a Lossless window; the vault rule stays flat', () => {
    const d = packBackDetails({ ...pack151, buybackPercent: 100 }, published);
    expect(d.buyback?.headline).toBe('100% instant buyback');
    expect(d.buyback?.rule).toContain('changes buyback to 90% of card value');
    expect(buybackHeadline({})).toBe('90% instant buyback');
  });

  it('prints no price or buyback for the free pack, and no buyback for a ticket pack', () => {
    const free = packBackDetails(
      { ...pack151, categoryId: 'free_welcome' },
      published,
    );
    expect(free.price).toBeNull();
    expect(free.buyback).toBeNull();
    const ticket = packBackDetails(
      { ...pack151, prizeType: 'tickets' },
      published,
    );
    expect(ticket.buyback).toBeNull();
    expect(ticket.odds).toHaveLength(6);
  });

  it('prints no odds when none are published or passed', () => {
    expect(packBackDetails(pack151, null).odds).toBeNull();
    expect(packBackDetails(pack151, undefined).odds).toBeNull();
    expect(packBackDetails(pack151, { tiers: {} }).odds).toBeNull();
  });

  it('uses the price formatter the page uses', () => {
    expect(packBackDetails({ ...pack151, priceMyr: 1234.5 }, null).price).toBe(
      'RM 1,234.50',
    );
  });

  it("matches the pack page's own buyback wording (drift guard)", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL('../../app/slots/[slug]/PackDetailClient.tsx', import.meta.url),
      ),
      'utf8',
    )
      .replace(/\{' '\}/g, ' ')
      .replace(/\{FLAT_BUYBACK_PERCENT\}/g, '90')
      .replace(/\s+/g, ' ');
    expect(src).toContain(BUYBACK_RULE);
    expect(src).toContain(
      '{active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% instant buyback',
    );
  });
});
