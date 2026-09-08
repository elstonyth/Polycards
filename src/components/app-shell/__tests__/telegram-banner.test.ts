// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let pathname = '/';
const auth = { customer: null as { id: string } | null, isLoading: false };
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
vi.mock('@/components/auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('@/lib/use-consent', () => ({ useConsent: () => 'rejected' }));
const { TelegramBanner } = await import('../TelegramBanner');
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const render = () => act(() => root.render(createElement(TelegramBanner)));
const banner = () => container.querySelector('[data-telegram-banner]');
const close = () => act(() => container.querySelector('button')!.click());

beforeEach(() => {
  pathname = '/';
  auth.customer = null;
  auth.isLoading = false;
  sessionStorage.clear();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test('guests always see banner without close, ignoring old permanent dismissal', () => {
  localStorage.setItem('polycards.telegram-banner-dismissed', 'true');
  render();
  expect(banner()).not.toBeNull();
  expect(container.querySelector('button')).toBeNull();
});

test('dismissal survives navigation, auth refresh, and remount in same login', () => {
  auth.customer = { id: 'customer-1' };
  render();
  close();
  pathname = '/about';
  auth.customer = { id: 'customer-1' };
  render();
  expect(banner()).toBeNull();
  act(() => root.unmount());
  root = createRoot(container);
  render();
  expect(banner()).toBeNull();
});

test('logout on hidden route resets dismissal before same customer logs in again', () => {
  auth.customer = { id: 'customer-1' };
  render();
  close();
  pathname = '/vault';
  auth.customer = null;
  render();
  pathname = '/';
  auth.customer = { id: 'customer-1' };
  render();
  expect(banner()).not.toBeNull();
});

test('another customer never inherits dismissal', () => {
  auth.customer = { id: 'customer-1' };
  render();
  close();
  auth.customer = { id: 'customer-2' };
  render();
  expect(banner()).not.toBeNull();
});

test('auth hydration does not clear same-login dismissal', () => {
  auth.customer = { id: 'customer-1' };
  render();
  close();
  act(() => root.unmount());
  root = createRoot(container);
  auth.customer = null;
  auth.isLoading = true;
  render();
  auth.customer = { id: 'customer-1' };
  auth.isLoading = false;
  render();
  expect(banner()).toBeNull();
});
