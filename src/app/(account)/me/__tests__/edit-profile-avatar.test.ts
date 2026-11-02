// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The avatar grid in Edit Profile: a tap sends the catalog id, the tile they
// already have is marked, and a refusal says so instead of pretending it stuck.

const setPresetAvatar = vi.fn();
vi.mock('@/lib/actions/customer', () => ({ updateProfile: vi.fn() }));
vi.mock('@/lib/actions/profile-appearance', () => ({
  uploadAvatar: vi.fn(),
  setAvatarFrame: vi.fn(),
  setPresetAvatar: (...args: unknown[]) => setPresetAvatar(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('../equipped-frame', () => ({
  useEquippedFrame: () => ({ equipped: null, setEquipped: vi.fn() }),
}));

import { EditProfileModal } from '../EditProfileModal';
import { AVATAR_COUNT, avatarPath } from '@/lib/avatar-seed';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

function render(avatarUrl: string | null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(EditProfileModal, {
        open: true,
        onClose: vi.fn(),
        displayName: 'Elston',
        username: 'Elston',
        handle: 'Elston',
        avatarUrl,
        frames: {},
        highestLevel: 16,
      }),
    );
  });
}

const tile = (id: number) =>
  document.querySelector<HTMLButtonElement>(
    `button[aria-label^="Use avatar ${id}"],button[aria-label^="Avatar ${id} "]`,
  );

beforeEach(() => setPresetAvatar.mockReset());
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('EditProfileModal avatar grid', () => {
  it('offers the whole catalog', () => {
    render(null);
    expect(
      document.querySelectorAll('button[aria-label^="Use avatar"]').length,
    ).toBe(AVATAR_COUNT);
  });

  it('marks the avatar they have now', () => {
    render(avatarPath(7));
    expect(tile(7)?.getAttribute('aria-pressed')).toBe('true');
    expect(tile(8)?.getAttribute('aria-pressed')).toBe('false');
    // Re-picking it would only be a pointless write.
    expect(tile(7)?.disabled).toBe(true);
  });

  it('marks nothing for an uploaded photo', () => {
    render('https://cdn.example/me.webp');
    expect(
      document.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toBe('Avatars');
    expect(tile(1)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a tap sends the catalog id', async () => {
    setPresetAvatar.mockResolvedValue({ ok: true });
    render(null);
    await act(async () => {
      tile(12)?.click();
    });
    expect(setPresetAvatar).toHaveBeenCalledWith(12);
  });

  it('shows the refusal', async () => {
    setPresetAvatar.mockResolvedValue({
      ok: false,
      error: 'Too many requests',
    });
    render(null);
    await act(async () => {
      tile(12)?.click();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Too many requests',
    );
  });

  it('frames sit behind their own tab', () => {
    render(null);
    expect(document.body.textContent).not.toContain('Unlock a new frame');
    const framesTab = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Frames',
    );
    act(() => framesTab?.click());
    expect(document.body.textContent).toContain('Unlock a new frame');
    expect(tile(1)).toBeNull();
  });
});
