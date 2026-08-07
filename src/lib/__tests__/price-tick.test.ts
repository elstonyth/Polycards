import { describe, it, expect } from 'vitest';
import { initialPriceTick, nextPriceTick } from '@/lib/price-tick';

describe('nextPriceTick', () => {
  it('does not pulse on the first real price (overlay hydrating from a seed)', () => {
    // The overlay mounts with no detail yet, then the endpoint lands.
    const seeded = initialPriceTick('charizard', null);
    const hydrated = nextPriceTick(seeded, 'charizard', 100);
    expect(hydrated.n).toBe(0);
    expect(hydrated.price).toBe(100);
  });

  it('pulses up, then down, on genuine poll changes', () => {
    let s = initialPriceTick('charizard', 100);
    s = nextPriceTick(s, 'charizard', 120);
    expect(s.n).toBe(1);
    expect(s.up).toBe(true);

    s = nextPriceTick(s, 'charizard', 90);
    expect(s.n).toBe(2);
    expect(s.up).toBe(false);
  });

  it('stays silent when the price is unchanged or absent', () => {
    const s = initialPriceTick('charizard', 100);
    expect(nextPriceTick(s, 'charizard', 100)).toBe(s);
    expect(nextPriceTick(s, 'charizard', null)).toBe(s);
  });

  it('stays silent on a sub-cent move the UI cannot render', () => {
    // An FX wobble that leaves "RM 100.00" on screen must not flash the page.
    const s = initialPriceTick('charizard', 100);
    expect(nextPriceTick(s, 'charizard', 100.001)).toBe(s);
    // ...but a real one-cent move still pulses.
    expect(nextPriceTick(s, 'charizard', 100.01).n).toBe(1);
  });

  it('is a fixed point once settled, so the render-time adjust terminates', () => {
    // CardDetail calls this during render and setStates when the result differs.
    // If it never converged, that would be an infinite render loop.
    const a = nextPriceTick(
      initialPriceTick('charizard', 100),
      'charizard',
      120,
    );
    expect(nextPriceTick(a, 'charizard', 120)).toBe(a);
  });

  it('re-baselines on a card switch instead of flashing', () => {
    // The regression this guards: card A at 100, overlay reused for card B at
    // 900. Comparing B against A's baseline would pulse on every switch.
    const a = { handle: 'charizard', price: 100, n: 3, up: true };
    const b = nextPriceTick(a, 'pikachu', 900);
    expect(b.n).toBe(0);
    expect(b.price).toBe(900);

    // ...and B's own first poll change still pulses normally afterwards.
    expect(nextPriceTick(b, 'pikachu', 950).n).toBe(1);
  });
});
