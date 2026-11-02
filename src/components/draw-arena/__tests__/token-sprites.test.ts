// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadTokenSprites } from '../token-sprites';

// A disc must wear its owner's picture, whoever else shares it, and never another
// player's. Canvas drawing is stubbed; which image lands on whom is what's tested.

class FakeImage {
  static all: FakeImage[] = [];
  decoding = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 320;
  naturalHeight = 320;
  src = '';
  constructor() {
    FakeImage.all.push(this);
  }
  decode() {
    return Promise.resolve();
  }
}
const named = (src: string) => FakeImage.all.find((i) => i.src === src);
const settle = () => new Promise((r) => setTimeout(r, 0));

const drawn = new WeakMap<HTMLCanvasElement, string[]>();

beforeEach(() => {
  FakeImage.all = [];
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      const note = (what: string) =>
        drawn.set(this, [...(drawn.get(this) ?? []), what]);
      return new Proxy(
        {},
        {
          get(_t, key) {
            if (
              key === 'createRadialGradient' ||
              key === 'createLinearGradient'
            ) {
              return () => ({ addColorStop: () => undefined });
            }
            if (key === 'drawImage') return (img: FakeImage) => note(img.src);
            if (key === 'fillText')
              return (text: string) => note(`letter:${text}`);
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
  vi.unstubAllGlobals();
});

describe('whose picture is on the disc', () => {
  test('each player gets their own, however many players there are', async () => {
    const people = Array.from({ length: 326 }, (_, i) => ({
      who: `Player${i}`,
      avatar: `/images/avatars/${i}.webp`,
    }));
    const sprites = loadTokenSprites(people);
    for (const img of FakeImage.all) img.onload?.();
    await sprites.ready;
    for (const [entry, person] of people.entries()) {
      const token = sprites.get(entry) as HTMLCanvasElement;
      expect(drawn.get(token)).toEqual([person.avatar]);
    }
  });

  test('an upload and a preset path both load, and one image is fetched once', async () => {
    const people = [
      { who: 'Ada', avatar: 'https://cdn.test/avatars/ada.webp' },
      { who: 'Bo', avatar: '/images/avatars/7.webp' },
      { who: 'Cy', avatar: '/images/avatars/7.webp' },
    ];
    const sprites = loadTokenSprites(people);
    expect(FakeImage.all.map((i) => i.src).sort()).toEqual([
      '/images/avatars/7.webp',
      'https://cdn.test/avatars/ada.webp',
    ]);
    for (const img of FakeImage.all) img.onload?.();
    await sprites.ready;
    expect(drawn.get(sprites.get(0) as HTMLCanvasElement)).toEqual([
      people[0]?.avatar,
    ]);
    expect(sprites.get(1)).toBe(sprites.get(2));
    expect(sprites.get(1)).not.toBe(sprites.get(0));
  });

  test('a letter stands in until the picture arrives, then the picture takes over', async () => {
    const sprites = loadTokenSprites([{ who: 'ada', avatar: '/a.webp' }]);
    expect(drawn.get(sprites.get(0) as HTMLCanvasElement)).toEqual([
      'letter:A',
    ]);
    named('/a.webp')?.onload?.();
    await sprites.ready;
    expect(drawn.get(sprites.get(0) as HTMLCanvasElement)).toEqual(['/a.webp']);
  });

  test('a broken picture leaves the letter, and never holds up the show', async () => {
    const sprites = loadTokenSprites([
      { who: 'Ada', avatar: '/gone.webp' },
      { who: 'Bo', avatar: '/fine.webp' },
    ]);
    named('/gone.webp')?.onerror?.();
    named('/fine.webp')?.onload?.();
    await sprites.ready;
    expect(drawn.get(sprites.get(0) as HTMLCanvasElement)).toEqual([
      'letter:A',
    ]);
    expect(drawn.get(sprites.get(1) as HTMLCanvasElement)).toEqual([
      '/fine.webp',
    ]);
  });

  test('a player with no picture gets a letter, not someone else’s face', async () => {
    const sprites = loadTokenSprites([
      { who: 'Anonymous', avatar: null },
      { who: 'Bo', avatar: '/bo.webp' },
    ]);
    named('/bo.webp')?.onload?.();
    await sprites.ready;
    expect(drawn.get(sprites.get(0) as HTMLCanvasElement)).toEqual([
      'letter:A',
    ]);
    expect(FakeImage.all).toHaveLength(1);
  });

  test('stopped, a late picture is ignored', async () => {
    const sprites = loadTokenSprites([{ who: 'Ada', avatar: '/a.webp' }]);
    sprites.stop();
    named('/a.webp')?.onload?.();
    await settle();
    expect(drawn.get(sprites.get(0) as HTMLCanvasElement)).toEqual([
      'letter:A',
    ]);
  });
});
