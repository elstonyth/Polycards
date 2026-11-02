// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { arenaDots, arenaSeed, castDiscs } from '@/lib/arena/cast';
import { runArena } from '@/lib/arena/engine';
import { createArenaRenderer } from '../arena-render';

// Every disc alive must reach the screen. Live gates' first local run: on a table
// big enough that discs start under 2.5 px, the shown radius was never set and
// tokens drew at size zero, leaving an empty table that said 610 discs left.

type Draw = { w: number; h: number; source: unknown };
let draws: Draw[] = [];

beforeEach(() => {
  draws = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function () {
      return new Proxy(
        {},
        {
          get(_t, key) {
            if (
              key === 'createRadialGradient' ||
              key === 'createLinearGradient' ||
              key === 'createConicGradient'
            ) {
              return () => ({ addColorStop: () => undefined });
            }
            if (key === 'measureText') return () => ({ width: 10 });
            if (key === 'drawImage') {
              return (source: unknown, ...a: number[]) =>
                draws.push({ source, w: a[2] ?? 0, h: a[3] ?? 0 });
            }
            return () => undefined;
          },
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;
    } as never,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const table = (players: number, size: number, pictures = players) => {
  const dots = arenaDots(players);
  const seed = arenaSeed(`render-${players}`);
  const run = runArena(seed, dots);
  const tickets = Array.from({ length: players }, (_, i) =>
    i === 0 ? 400 : 5,
  );
  const owners = castDiscs({
    tickets,
    winner: 0,
    me: 1,
    survivor: run.survivor,
    dots,
    seed,
  });
  const faces = Array.from({ length: pictures }, () =>
    document.createElement('canvas'),
  );
  const canvas = document.createElement('canvas');
  const renderer = createArenaRenderer(
    canvas,
    { run, owners, names: tickets.map((_, i) => `P${i}`), me: 1 },
    { get: (entry) => faces[entry % pictures] ?? null },
  );
  renderer.resize(size, size);
  draws = [];
  return { renderer };
};

describe('every disc reaches the screen', () => {
  // What a customer does: the show starts in the corner, where discs are too small
  // for a face, and a tap opens it on a table big enough for them.
  const tapped = (renderer: {
    draw: (t: number, dt: number) => void;
    resize: (w: number, h: number) => void;
  }) => {
    for (let t = 0; t < 2000; t += 16) renderer.draw(t, 0.016);
    renderer.resize(390, 390);
    renderer.draw(2016, 0.016);
    draws = [];
    renderer.draw(2032, 0.016);
  };

  test.each([
    ['a gate today', 305],
    ['where discs start under 2.5 px', 326],
    ['a bigger gate', 380],
  ])('%s, tapped open from the corner', (_name, players) => {
    const { renderer } = table(players, 170);
    tapped(renderer);
    expect(draws.filter((d) => d.w === 0 || d.h === 0)).toEqual([]);
    expect(draws.length).toBeGreaterThan(50);
  });

  test('small discs share one small copy per picture', () => {
    const { renderer } = table(305, 170, 5);
    tapped(renderer);
    expect(draws.length).toBeGreaterThan(50);
    // Five minis, five full tokens for the big discs, and the shadow, at most.
    expect(new Set(draws.map((d) => d.source)).size).toBeLessThanOrEqual(11);
  });
});
