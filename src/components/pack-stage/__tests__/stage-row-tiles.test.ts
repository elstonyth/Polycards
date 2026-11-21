/**
 * The CSS tiles as the painter poses them: a capsule's tile takes the capsule
 * flag from the row on show (the tiles carry only their names), and with it
 * the capsule's lean limits in every term the painter draws: the paged spin
 * and its exit (the hand-off and the lineup), the focus stops, the rise and
 * the return.
 */
import { describe, expect, it } from 'vitest';

import type { FocusCtx, Pose, StageLayout, StageState } from '../contract';
import { CAPSULE_LIMITS, SLEEVE_TILE } from '../stage-capsule-lean';
import { FOCUS_TERM } from '../stage-compose';
import { focusKeys } from '../stage-focus-keys';
import { rowTilePacks, tilePose, tileSpinCtx } from '../stage-row-tiles';
import { poseAt, restState } from '../stage-pose';
import { LEAN } from '../stage-spin-math';
import { lineupCopies } from '../stage-spin';

const SIZES = [
  {
    desktop: false,
    l: { cx: 0, cy: 330, step: 180, artH: 352, artW: 190 } as StageLayout,
    panel: { w: 390, h: 716, anchorY: 0.46, viewH: 844 },
  },
  {
    desktop: true,
    l: { cx: 0, cy: 400, step: 330, artH: 560, artW: 300 } as StageLayout,
    panel: { w: 1440, h: 831, anchorY: 0.48, viewH: 900 },
  },
];
const N = 5;
const EPS = 1e-9;
const CAPSULES = rowTilePacks(
  Array.from({ length: N }, (_, i) => `Capsule ${i}, RM 10`),
  Array.from({ length: N }, () => ({ ticket: true, soldOut: false })),
);

const over = (p: Pose) =>
  Math.abs(p.rotY) > CAPSULE_LIMITS.yaw + EPS ||
  p.rotX > CAPSULE_LIMITS.tipAway + EPS ||
  -p.rotX > CAPSULE_LIMITS.tipToward + EPS;

function within(p: Pose, what: string) {
  expect(Math.abs(p.rotY), `${what} yaw`).toBeLessThanOrEqual(
    CAPSULE_LIMITS.yaw + EPS,
  );
  expect(p.rotX, `${what} away`).toBeLessThanOrEqual(
    CAPSULE_LIMITS.tipAway + EPS,
  );
  expect(-p.rotX, `${what} toward`).toBeLessThanOrEqual(
    CAPSULE_LIMITS.tipToward + EPS,
  );
}

describe('rowTilePacks', () => {
  it('takes the capsule flag and the sold-out state from the row on show', () => {
    const out = rowTilePacks(
      ['Gold Capsule, RM 10', 'Silver Capsule, RM 5, sold out'],
      [
        { ticket: true, soldOut: false },
        { ticket: true, soldOut: true },
      ],
    );
    expect(out).toEqual([
      { soldOut: false, ticket: true },
      { soldOut: true, ticket: true },
    ]);
    expect(CAPSULES.every((p) => p.ticket)).toBe(true);
  });

  it("reads sold out from the row entry, whatever the tile's name says", () => {
    expect(
      rowTilePacks(
        ['Gold, RM 10, sold out', 'Silver, RM 5'],
        [
          { ticket: false, soldOut: false },
          { ticket: false, soldOut: true },
        ],
      ),
    ).toEqual([
      { soldOut: false, ticket: false },
      { soldOut: true, ticket: false },
    ]);
  });

  it('a capsule leans by the capsule yaw limit and a sleeve by LEAN', () => {
    const panel = SIZES[0]!.panel;
    expect(tileSpinCtx(N, CAPSULES[0]!, 0, panel).spin!.lean).toBe(
      CAPSULE_LIMITS.yaw,
    );
    expect(tileSpinCtx(N, SLEEVE_TILE, 0, panel).spin!.lean).toBe(LEAN);
  });

  it('keeps sleeves as sleeves, and a tile with no row entry a sleeve', () => {
    expect(SLEEVE_TILE).toEqual({ soldOut: false, ticket: false });
    expect(
      rowTilePacks(
        ['151, RM 30', null, 'Extra'],
        [{ ticket: false, soldOut: false }],
      ),
    ).toEqual([SLEEVE_TILE, SLEEVE_TILE, SLEEVE_TILE]);
    expect(rowTilePacks(['151, sold out'], undefined)).toEqual([
      { soldOut: true, ticket: false },
    ]);
  });
});

describe('tilePose: a capsule tile keeps the lean limits', () => {
  for (const { desktop, l, panel } of SIZES) {
    const name = desktop ? 'desktop' : 'phone';

    it(`${name}: the spin, its exit and the lineup, every slot and copy`, () => {
      let rawOver = false;
      for (let track = 0; track < N; track++)
        for (let i = 0; i < N; i++)
          for (let k = 1; k <= 100; k++) {
            const spin = k / 100;
            const exits =
              spin === 1 ? Array.from({ length: 101 }, (_, e) => e / 100) : [0];
            for (const exit of exits) {
              const s: StageState = { ...restState(track), spin, exit };
              for (const copy of lineupCopies(i, track, N, desktop)) {
                const ctx = tileSpinCtx(N, CAPSULES[i]!, exit, panel);
                ctx.spin!.copy = copy;
                const what = `track=${track} i=${i} spin=${spin} exit=${exit} copy=${copy}`;
                within(tilePose(s, i, l, desktop, CAPSULES[i]!, ctx), what);
                if (over(poseAt(s, i, l, desktop, false, ctx))) rawOver = true;
              }
            }
          }
      // the composed pose alone turns past the limits: the clamp is doing work
      expect(rawOver).toBe(true);
    });

    it(`${name}: every focus stop and every move between them`, () => {
      const keys = focusKeys('gold-capsule', desktop, 'capsule');
      const focus: FocusCtx = {
        index: 2,
        anchorY: panel.anchorY,
        keys,
        panel: { w: panel.w, h: panel.h },
        fit: 1,
      };
      for (let f = 0; f <= keys.length * 100; f++)
        for (const pointerX of [-1, 0, 1]) {
          const s: StageState = {
            ...restState(2),
            spin: 1,
            focus: f / 100,
            pointerX,
          };
          for (let i = 0; i < N; i++) {
            const ctx = tileSpinCtx(N, CAPSULES[i]!, 0, panel);
            ctx.focus = focus;
            ctx.focusTerm = FOCUS_TERM;
            within(
              tilePose(s, i, l, desktop, CAPSULES[i]!, ctx),
              `focus=${f / 100} px=${pointerX} i=${i}`,
            );
          }
        }
    });

    it(`${name}: the rise and the return`, () => {
      let rawOver = false;
      for (let k = 0; k <= 100; k++)
        for (const lap of [
          { rise: k / 100, ret: 0, free: false, trim: false },
          { rise: 1, ret: k / 100, free: false, trim: false },
        ])
          for (const pointerX of [-1, 0, 1])
            for (let i = 0; i < N; i++) {
              const s: StageState = { ...restState(2), pointerX, lap };
              const ctx = tileSpinCtx(N, CAPSULES[i]!, 0, panel);
              within(
                tilePose(s, i, l, desktop, CAPSULES[i]!, ctx),
                `rise=${lap.rise} ret=${lap.ret} px=${pointerX} i=${i}`,
              );
              if (over(poseAt(s, i, l, desktop, false, ctx))) rawOver = true;
            }
      expect(rawOver).toBe(true);
    });
  }

  it('a sleeve tile keeps its composed pose as it is', () => {
    const { desktop, l, panel } = SIZES[1]!;
    const sleeve = { soldOut: false, ticket: false };
    for (let k = 1; k <= 20; k++) {
      const s: StageState = { ...restState(1), spin: k / 20 };
      for (let i = 0; i < N; i++) {
        const ctx = tileSpinCtx(N, sleeve, 0, panel);
        expect(tilePose(s, i, l, desktop, sleeve, ctx)).toEqual(
          poseAt(s, i, l, desktop, false, ctx),
        );
      }
    }
  });
});
