// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FaqAccordion from '../FaqAccordion';

// A collapsed answer is only visually hidden (grid rows 0, opacity 0), so a
// link inside it would still take keyboard focus. `inert` takes it out.

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

const answerOf = (text: string) => {
  const el = [...container.querySelectorAll('div')].find(
    (d) => d.textContent === text,
  );
  if (!el) throw new Error(`answer "${text}" not rendered`);
  return el;
};

describe('FaqAccordion', () => {
  test('only the open answer is reachable; a collapsed one is inert', () => {
    act(() =>
      root.render(
        createElement(FaqAccordion, {
          items: [
            { q: 'First?', a: 'Open answer' },
            { q: 'Second?', a: 'Closed answer' },
          ],
        }),
      ),
    );
    // The first item starts open.
    expect(answerOf('Open answer').closest('[inert]')).toBeNull();
    expect(answerOf('Closed answer').closest('[inert]')).not.toBeNull();

    // Opening the second one closes the first.
    const second = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Second?',
    )!;
    act(() => second.click());
    expect(answerOf('Closed answer').closest('[inert]')).toBeNull();
    expect(answerOf('Open answer').closest('[inert]')).not.toBeNull();
  });
});
