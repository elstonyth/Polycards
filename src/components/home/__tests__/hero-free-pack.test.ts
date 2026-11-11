import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { FreePackState } from '@/lib/data/free-pack';

const auth: { customer: { id: string } | null; isLoading: boolean } = {
  customer: null,
  isLoading: false,
};
let answer: FreePackState | null = null;
vi.mock('@/components/auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('@/components/FreePackBadge', () => ({
  useFreePackState: () => answer,
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: () => {} }));

const { HeroFreePack } = await import('../HeroFreePack');
const html = (promo: boolean) =>
  renderToStaticMarkup(createElement(HeroFreePack, { promo }));

beforeEach(() => {
  auth.customer = null;
  auth.isLoading = false;
  answer = null;
});

it('a member never sees the sign-up pitch while their own answer is pending', () => {
  auth.customer = { id: 'cus_1' };
  expect(html(true)).toBe('');
});

it('a member with an unclaimed pack gets a claim link to its spin page', () => {
  auth.customer = { id: 'cus_1' };
  answer = { mode: 'claim', slug: 'free 151' };
  const out = html(true);
  expect(out).toContain('href="/slots/free%20151/spin"');
  expect(out).toContain('Your free pack is ready');
  expect(out).toContain('No top-up needed');
});

it('a claim still waiting on verification says so', () => {
  auth.customer = { id: 'cus_1' };
  answer = { mode: 'claim', slug: 'free-151', missing: ['phone'] };
  expect(html(true)).toContain('Verify your account, then open it.');
});

it('the client answer wins over the server offer once it lands', () => {
  answer = { mode: 'hidden' };
  expect(html(true)).toBe('');
});

it('a guest with no answer yet sees the server offer, or nothing without one', () => {
  expect(html(true)).toContain('Your first pack is free');
  expect(html(false)).toBe('');
});
