import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import TrustBoard from '../TrustBoard';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

// The board's copy is a set of claims PRODUCT.md binds; pin what it may say.
const html = renderToStaticMarkup(createElement(TrustBoard));
const text = html.replace(/<[^>]+>/g, ' ');

it('names both buyback contexts, never one rate alone', () => {
  expect(text).toContain('instant rate');
  expect(text).toContain(`${BUYBACK_RATE_LABEL} of card value`);
});

it('ships only where we ship and says how pulls are drawn', () => {
  expect(text).toContain('Malaysia');
  expect(text).toContain('Singapore');
  expect(text).not.toMatch(/worldwide|international|insur/i);
  expect(text).toContain('cryptographically secure random draw');
});

it('makes no claim we cannot back, and links nowhere deleted', () => {
  expect(text).not.toMatch(/graded|provably|100% fair|PSA/i);
  expect(html).not.toContain('/fairness');
  expect(html).toContain('href="/how-it-works"');
});
