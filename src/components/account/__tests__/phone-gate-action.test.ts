// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { friendlyError } from '@/lib/errors';
import { VAULT_RULES, VAULT_FALLBACK } from '@/lib/vault-errors';
import { DELIVERY_RULES, DELIVERY_FALLBACK } from '@/lib/delivery-errors';

// The gate (backend requirePhoneVerified) is flag-off in dev/CI, so no local
// run can drive this button by hitting a real 403. These pin the two halves a
// live hit would prove: the mapped copy still trips the predicate, and the
// component turns that into a link to the screen that clears the gate.

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => createElement('a', { href, ...rest }, children),
}));

const { PhoneGateAction } = await import('../PhoneGateAction');

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(error: string | null, onNavigate?: () => void) {
  await act(async () => {
    root.render(createElement(PhoneGateAction, { error, onNavigate }));
  });
  return container.querySelector('a');
}

// The exact string every gated route throws (phone-verification-guard.ts).
const GUARD = 'Verify your phone number before continuing.';

describe('PhoneGateAction', () => {
  test('offers the settings link for the top-up/withdrawal gate copy', async () => {
    const link = await render(
      friendlyError(new Error(GUARD), VAULT_RULES, VAULT_FALLBACK),
    );
    expect(link?.getAttribute('href')).toBe('/settings');
  });

  test('offers it for the delivery gate copy too', async () => {
    const link = await render(
      friendlyError(new Error(GUARD), DELIVERY_RULES, DELIVERY_FALLBACK),
    );
    expect(link?.getAttribute('href')).toBe('/settings');
  });

  test('stays out of the way for every other error, and for none', async () => {
    expect(
      await render(
        friendlyError(new Error('kaboom'), VAULT_RULES, VAULT_FALLBACK),
      ),
    ).toBeNull();
    expect(await render('Not enough balance for that.')).toBeNull();
    expect(await render(null)).toBeNull();
  });

  // Two of the three call sites are modals owning their own open state: a bare
  // link would leave the sheet overlaying /settings after the navigation.
  test('closes its host modal on the way out', async () => {
    const onNavigate = vi.fn();
    const link = await render(
      friendlyError(new Error(GUARD), VAULT_RULES, VAULT_FALLBACK),
      onNavigate,
    );
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
