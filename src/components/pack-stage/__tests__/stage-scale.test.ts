/**
 * The homepage stage with small and large catalogues: what an operator adds
 * or removes in the admin (a pack, a capsule, a pack with no bundled 3D set)
 * must need no code change. Rows of 1, 2, 3, 6, 10 and 16 packs; 2, 5 and 9
 * capsules.
 */
import { describe, expect, it } from 'vitest';
import type { Pack, PackCategory } from '@/lib/packs-data';
import type { StageArt } from '../contract';
import {
  RESIDENCY_DESKTOP,
  RESIDENCY_PHONE,
  planResidency,
  textureBytes,
} from '../runtime/stage-residency';
import { FLOW_DETAIL_SLOTS, flowSlots, flowTable } from '../stage-flow';
import { createFlowLine } from '../stage-flow-line';
import { stageStartIndex } from '../stage-filter';
import { toStageCategories } from '../stage-packs';
import { LINEUP_ROW, lineupCopies, wrapRow } from '../stage-spin';

const PACK_COUNTS = [1, 2, 3, 6, 10, 16];
const CAPSULE_COUNTS = [2, 5, 9];

const sleeve = (k: number): Pack => ({
  id: `new-pack-${k}`,
  name: `New Pack ${k}`,
  priceMyr: 10 + k,
  image: `/images/polycards/new-pack-${k}.webp`,
});
const capsule = (k: number): Pack => ({
  ...sleeve(k),
  id: `new-capsule-${k}`,
  prizeType: 'tickets',
});
const category = (packs: Pack[]): PackCategory => ({
  id: 'pokemon',
  tab: 'Pokémon',
  heading: 'Pokémon Packs',
  icon: '/pack-index-icons/pokemon.webp',
  packs,
});
const ART: StageArt = {
  front: '/f.webp',
  frontHalf: '/h.webp',
  width: 925,
  height: 1666,
};
/** Every other new pack has a bundled 3D set; the rest only their picture. */
const someArt = (id: string) => (Number(id.split('-').pop()) % 2 ? ART : null);

describe('catalogue to stage rows', () => {
  for (const n of PACK_COUNTS) {
    it(`keeps all ${n} packs, the ones with no 3D set on their picture`, () => {
      const packs = Array.from({ length: n }, (_, k) => sleeve(k));
      const [row] = toStageCategories([category(packs)], new Map(), someArt);
      expect(row!.packs.map((p) => p.id).sort()).toEqual(
        packs.map((p) => p.id).sort(),
      );
      for (const p of row!.packs) {
        expect(p.image).toMatch(/^\/images\//);
        expect(p.art3d).toBe(someArt(p.id));
      }
      expect(row!.shelves[0]!.count).toBe(n);
      const start = stageStartIndex(row!.packs);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThan(n);
    });
  }

  for (const n of CAPSULE_COUNTS) {
    it(`keeps all ${n} capsules; one with no fitted model is its picture`, () => {
      const packs = Array.from({ length: n }, (_, k) => capsule(k));
      const [row] = toStageCategories([category(packs)], new Map(), () => ART);
      expect(row!.packs).toHaveLength(n);
      for (const p of row!.packs) {
        expect(p.ticket).toBe(true);
        // capsules never borrow the sleeve catalogue
        expect(p.art3d).toBeNull();
      }
    });
  }

  it('a known capsule keeps its fitted model at its own picture', () => {
    const lucky = { ...capsule(0), id: 'lucky-pack' };
    const [row] = toStageCategories([category([lucky])], new Map());
    expect(row!.packs[0]!.art3d).toMatchObject({
      shape: 'capsule',
      front: lucky.image,
    });
  });

  it('a new group with packs gets its own row; an empty one gets none', () => {
    const rows = toStageCategories(
      [
        category([sleeve(1)]),
        { ...category([capsule(1), capsule(2)]), id: 'new-group' },
        { ...category([]), id: 'coming-soon' },
      ],
      new Map(),
      someArt,
    );
    expect(rows.map((r) => r.id)).toEqual(['pokemon', 'new-group']);
  });
});

describe('the flow table never depends on the row', () => {
  it('rests every stop count inside the six-slot band', () => {
    for (const stops of [4, 5, 6]) {
      const s = flowSlots(stops);
      expect(s).toHaveLength(stops);
      expect(s[0]).toBe(1);
      expect(s.at(-1)).toBe(FLOW_DETAIL_SLOTS);
    }
  });

  it('puts the lineup at the same place for every stop count', () => {
    const at = (stops: number) =>
      flowTable({ top: 0, panel: 800, stops, viewport: 800 })!.rl;
    expect(at(6)).toBeGreaterThan(0);
    expect(at(4)).toEqual(at(6));
    expect(at(5)).toEqual(at(6));
  });
});

describe('the tilted lineup with any row length', () => {
  for (const n of PACK_COUNTS) {
    for (const desktop of [false, true]) {
      it(`fills every drawn slot once: ${n} packs, ${desktop ? 'desktop' : 'phone'}`, () => {
        const reach =
          (desktop ? LINEUP_ROW.reachDesktop : LINEUP_ROW.reachPhone) + 1;
        for (const track of [0, 0.5, n - 1, n / 2]) {
          const seen = new Map<number, number>();
          for (let i = 0; i < n; i++) {
            const dp = n > 1 ? wrapRow(i - track, n) : i - track;
            for (const c of lineupCopies(i, track, n, desktop)) {
              const slot = Math.round((dp + c) * 2) / 2;
              seen.set(slot, (seen.get(slot) ?? 0) + 1);
            }
          }
          // every slot within reach, either side, is drawn exactly once
          for (const [slot, times] of seen) {
            if (Math.abs(slot) < reach) expect(times).toBe(1);
          }
          const step = Number.isInteger(track) ? 0 : 0.5;
          for (let s = -reach + 1; s < reach; s++) {
            const slot = s + step;
            if (Math.abs(slot) < reach) expect(seen.get(slot)).toBe(1);
          }
        }
      });
    }
  }

  for (const n of PACK_COUNTS) {
    it(`swipes endlessly over ${n} packs and rests on one`, () => {
      const line = createFlowLine();
      line.sync(0, n);
      let now = 0;
      line.grab(300, now);
      for (let k = 1; k <= 10; k++) {
        now += 16;
        line.drag(300 - 250 * k, now);
        line.frame(now);
      }
      line.release(now);
      let f = line.frame(now);
      for (let t = 0; t < 3000; t += 16) f = line.frame((now += 16));
      expect(f.moving).toBe(false);
      expect(f.index).toBeGreaterThanOrEqual(0);
      expect(f.index).toBeLessThan(n);
      expect(f.track).toBeGreaterThanOrEqual(-0.5);
      expect(f.track).toBeLessThan(n - 0.5 + 1e-9);
      expect(Number.isInteger(f.pos)).toBe(true);
    });
  }
});

describe('graphics memory with any row length', () => {
  const HALF = textureBytes(463, 833);
  const FULL = textureBytes(925, 1666);
  const bytes = (_i: number, res: 'half' | 'full') =>
    res === 'full' ? FULL : HALF;
  for (const n of PACK_COUNTS) {
    for (const config of [RESIDENCY_PHONE, RESIDENCY_DESKTOP]) {
      it(`stays in budget: ${n} packs, reach ${config.reach}`, () => {
        // only the packs with a 3D set are candidates (the runtime's slots)
        const indices = Array.from({ length: n }, (_, i) => i).filter(
          (i) => i % 3 !== 2,
        );
        const budget = 6 * HALF;
        for (const track of [0, Math.floor(n / 2), n - 1]) {
          const plan = planResidency({
            indices,
            track,
            direction: 1,
            config,
            promote: null,
            budgetBytes: budget,
            bytes,
            resident: new Map(),
            now: 0,
          });
          expect(plan.want.size).toBeLessThanOrEqual(config.maxResident);
          expect(plan.bytes).toBeLessThanOrEqual(budget);
          for (const i of plan.want.keys()) expect(indices).toContain(i);
          for (const i of plan.required)
            expect(Math.abs(i - track)).toBeLessThan(config.reach + 1);
          const near = indices.filter(
            (i) => Math.abs(i - track) < config.reach + 1,
          );
          if (near.length > 0) expect(plan.want.size).toBeGreaterThan(0);
        }
      });
    }
  }
});
