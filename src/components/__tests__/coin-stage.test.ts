// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CoinSceneProps } from '@/components/coin-flip/CoinStage';

const mocks = vi.hoisted(() => ({ scene: vi.fn(), reduced: false }));
vi.mock('next/dynamic', () => ({
  default: () => (props: CoinSceneProps) => {
    mocks.scene(props);
    return null;
  },
}));
vi.mock('@/lib/use-reveal', () => ({
  usePrefersReducedMotion: () => mocks.reduced,
}));
vi.mock('@/components/coin-flip/StaticCoin', () => ({
  StaticCoin: ({ side }: { side: string }) =>
    createElement('span', { 'data-static-face': side }),
}));
import { CoinStage } from '@/components/coin-flip/CoinStage';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let props: CoinSceneProps;
beforeEach(() => {
  mocks.reduced = false;
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  props = {
    armed: true,
    pending: false,
    revealed: false,
    outcome: null,
    side: 'tail',
    playbackId: null,
    profile: 0.5,
    onFlick: vi.fn(),
    onComplete: vi.fn(),
    onReadyChange: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function render(update: Partial<CoinSceneProps> = {}) {
  props = { ...props, ...update };
  await act(async () => root.render(createElement(CoinStage, props)));
}
function face() {
  return host
    .querySelector('[data-static-face]')
    ?.getAttribute('data-static-face');
}

describe('coin scene readiness', () => {
  it('shows the correct result and completes a tap while renderer assets remain delayed', async () => {
    await render();
    expect(face()).toBe('tail');
    expect(
      host.querySelector('[role=img]')?.getAttribute('aria-label'),
    ).not.toContain('Drag');
    await render({
      armed: false,
      outcome: 'lost',
      side: 'head',
      playbackId: 'settled',
    });
    expect(face()).toBe('head');
    expect(props.onComplete).toHaveBeenCalledTimes(1);
    await render({ playbackId: null });
    expect(host.querySelector('[role=img]')?.getAttribute('aria-label')).toBe(
      'Head landed.',
    );
    await act(async () => mocks.scene.mock.lastCall![0].onReadyChange(true));
    expect(face()).toBeUndefined();
    expect(props.onReadyChange).toHaveBeenLastCalledWith(true);
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });
  it('waits for the ready renderer but safely reveals the face if it fails during flight', async () => {
    await render();
    await act(async () => mocks.scene.mock.lastCall![0].onReadyChange(true));
    expect(
      host.querySelector('[role=img]')?.getAttribute('aria-label'),
    ).toContain('Drag upward');
    await render({
      armed: false,
      outcome: 'won',
      side: 'tail',
      playbackId: 'settled',
    });
    expect(props.onComplete).not.toHaveBeenCalled();
    expect(host.querySelector('[role=img]')?.getAttribute('aria-label')).toBe(
      'Coin in flight.',
    );
    await act(async () => mocks.scene.mock.lastCall![0].onReadyChange(false));
    expect(face()).toBe('tail');
    expect(props.onComplete).toHaveBeenCalledTimes(1);
    expect(props.onReadyChange).toHaveBeenLastCalledWith(false);
  });
  it('keeps reduced-motion mode tap-only and reveals the settled face', async () => {
    mocks.reduced = true;
    await render({
      armed: false,
      outcome: 'won',
      side: 'tail',
      playbackId: 'settled',
    });
    expect(mocks.scene).not.toHaveBeenCalled();
    expect(props.onReadyChange).toHaveBeenCalledWith(false);
    expect(props.onComplete).toHaveBeenCalledTimes(1);
    expect(face()).toBe('tail');
    expect(host.querySelector('[role=img]')?.getAttribute('aria-label')).toBe(
      'Tail landed.',
    );
  });
  it('resets readiness when reduced motion is toggled off again', async () => {
    await render();
    await act(async () => mocks.scene.mock.lastCall![0].onReadyChange(true));
    mocks.reduced = true;
    await render();
    expect(props.onReadyChange).toHaveBeenLastCalledWith(false);
    mocks.reduced = false;
    await render();
    expect(face()).toBe('tail');
    expect(
      host.querySelector('[role=img]')?.getAttribute('aria-label'),
    ).not.toContain('Drag');
  });
});
