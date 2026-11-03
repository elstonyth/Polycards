// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('@/lib/actions/customer', () => ({ saveRealName: vi.fn() }));

import { RealNameEntry } from '@/components/account/RealNameEntry';
import { REAL_NAME_TAKEN } from '@/lib/real-name';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mount = async (initialError?: string) => {
  const host = document.createElement('div');
  await act(async () => {
    createRoot(host).render(
      createElement(RealNameEntry, { onSaved: () => {}, initialError }),
    );
  });
  return host;
};

describe('RealNameEntry', () => {
  it('opens with the reason when signup had its name refused', async () => {
    const host = await mount(REAL_NAME_TAKEN);
    expect(host.textContent).toContain(REAL_NAME_TAKEN);
    expect(host.querySelector('a[href="/contact"]')).not.toBeNull();
  });

  it('opens with no error otherwise', async () => {
    const host = await mount();
    expect(host.textContent).not.toContain(REAL_NAME_TAKEN);
    expect(host.querySelector('a[href="/contact"]')).toBeNull();
  });
});
