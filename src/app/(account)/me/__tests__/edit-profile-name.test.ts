// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Tapping the name in Edit Profile renames the account. These pin the parts
// that can hurt a player: the field edits first_name (never the displayName
// fallback), a bad name never reaches the server, and the save sends
// first_name ALONE — a stray `last_name: ''` would clear their last name.

const updateProfile = vi.fn();
vi.mock('@/lib/actions/customer', () => ({
  updateProfile: (...args: unknown[]) => updateProfile(...args),
}));
vi.mock('@/lib/actions/profile-appearance', () => ({
  uploadAvatar: vi.fn(),
  setAvatarFrame: vi.fn(),
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock('../equipped-frame', () => ({
  useEquippedFrame: () => ({ equipped: null, setEquipped: vi.fn() }),
}));

import { EditProfileModal } from '../EditProfileModal';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(EditProfileModal, {
        open: true,
        onClose: vi.fn(),
        // displayName joins first + last; only first_name is editable.
        displayName: 'qqqqqqq Tan',
        username: 'qqqqqqq',
        handle: 'qqqqqqq',
        avatarUrl: null,
        frames: {},
        highestLevel: 16,
      }),
    );
  });
}

// The modal portals to document.body, so query the document, not container.
function button(text: RegExp): HTMLButtonElement {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    text.test(b.textContent ?? ''),
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn;
}

function nameInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    'input[aria-label="Username"]',
  );
}

function type(value: string) {
  const el = nameInput()!;
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(btn: HTMLButtonElement) {
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  // reset, not clear: no test may inherit another's resolved value.
  vi.resetAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('EditProfileModal name editor', () => {
  it('opens on the name, prefilled with first_name rather than displayName', async () => {
    render();
    expect(nameInput()).toBeNull();
    await click(button(/change username/));
    expect(nameInput()?.value).toBe('qqqqqqq');
  });

  it('never calls the server with an invalid name', async () => {
    render();
    await click(button(/change username/));
    type('has space');
    await click(button(/^Save$/));
    expect(updateProfile).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('can’t contain spaces');
  });

  it('saves first_name alone, then refreshes and refocuses the name', async () => {
    updateProfile.mockResolvedValue({
      ok: true,
      customer: {
        id: 'cus_1',
        email: 'q@example.com',
        first_name: 'new_name',
        last_name: 'Tan',
        phone: null,
      },
    });
    render();
    await click(button(/change username/));
    type('  new_name  ');
    await click(button(/^Save$/));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile.mock.calls[0]![0]).toStrictEqual({
      first_name: 'new_name',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(nameInput()).toBeNull();
    expect(document.activeElement).toBe(button(/change username/));
  });

  it('Cancel and an unchanged Save close the editor without a write', async () => {
    render();
    await click(button(/change username/));
    type('something_else');
    await click(button(/^Cancel$/));
    expect(nameInput()).toBeNull();
    // Focus goes back to the name, not <body>.
    expect(document.activeElement).toBe(button(/change username/));

    await click(button(/change username/));
    expect(nameInput()?.value).toBe('qqqqqqq');
    await click(button(/^Save$/));
    expect(nameInput()).toBeNull();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('keeps the editor open with the server refusal on a taken name', async () => {
    updateProfile.mockResolvedValue({
      ok: false,
      error: 'That username is taken — please pick another.',
    });
    render();
    await click(button(/change username/));
    type('taken_name');
    await click(button(/^Save$/));
    expect(nameInput()?.value).toBe('taken_name');
    expect(document.body.textContent).toContain('That username is taken');
    expect(refresh).not.toHaveBeenCalled();
  });
});
