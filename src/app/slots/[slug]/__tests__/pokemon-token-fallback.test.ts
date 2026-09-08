// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PokemonToken } from '../PokemonToken';
import { spriteGif, spritePng } from '@/lib/mock/pokedex';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(dex: number) {
  act(() => root.render(createElement(PokemonToken, { dex, name: 'Pokemon' })));
  return container.querySelector('img')!;
}

function fail(image: HTMLImageElement) {
  act(() => image.dispatchEvent(new Event('error')));
}

describe('PokemonToken image failures', () => {
  it.each([994, 995])(
    'reaches a stable fallback if static sprite %i fails',
    (dex) => {
      const image = render(dex);
      expect(image.src).toBe(spritePng(dex));
      fail(image);
      expect(image.src).toMatch(/^data:image\/svg\+xml,/);
      const fallback = image.src;
      fail(image);
      expect(image.src).toBe(fallback);
    },
  );

  it('retains the animated, static, then neutral fallback sequence', () => {
    const image = render(25);
    expect(image.src).toBe(spriteGif(25));
    fail(image);
    expect(image.src).toBe(spritePng(25));
    fail(image);
    expect(image.src).toMatch(/^data:image\/svg\+xml,/);
  });
});
