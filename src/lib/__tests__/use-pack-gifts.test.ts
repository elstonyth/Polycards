// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PackGift } from '@/lib/vault-packs';

// The one Pack Gift read the pack page and the spin page share: keyed to the
// customer + pack it was read for, re-read on invalidate(), decremented by
// consume(n). A failed read is `failed` with nothing held.

const mocks = vi.hoisted(() => ({ getPackGifts: vi.fn() }));
vi.mock('@/lib/actions/pack-gifts', () => ({
  getPackGifts: mocks.getPackGifts,
}));

const { usePackGifts } = await import('../use-pack-gifts');

type Gifts = ReturnType<typeof usePackGifts>;
type Props = { customerId: string | null; packId: string };

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
  mocks.getPackGifts.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
});

// renderHook without @testing-library: a probe component writes the latest
// result into `current`.
async function renderHook(initial: Props) {
  const result = { current: null as unknown as Gifts };
  function Probe(p: Props) {
    result.current = usePackGifts(p.customerId, p.packId);
    return null;
  }
  const rerender = (p: Props) =>
    act(async () => root.render(createElement(Probe, p)));
  await rerender(initial);
  return { result, rerender };
}

const gift = (count: number, over: Partial<PackGift> = {}): PackGift => ({
  packId: 'bronze',
  count,
  title: 'Bronze Pack',
  image: null,
  price: 300,
  available: true,
  ...over,
});

const ME = { customerId: 'cus_1', packId: 'bronze' };

describe('usePackGifts', () => {
  test('pending until the read lands, then the usable count for this pack', async () => {
    let resolve: (v: unknown) => void = () => {};
    mocks.getPackGifts.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = await renderHook(ME);
    expect(result.current).toMatchObject({
      held: 0,
      pending: true,
      failed: false,
    });
    await act(async () =>
      resolve([
        gift(2),
        gift(5, { packId: 'silver' }),
        gift(1, { available: false }),
      ]),
    );
    expect(result.current).toMatchObject({
      held: 2,
      pending: false,
      failed: false,
    });
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(1);
  });

  test('a null result is failed, holds none, and is not pending', async () => {
    mocks.getPackGifts.mockResolvedValue(null);
    const { result } = await renderHook(ME);
    expect(result.current).toMatchObject({
      held: 0,
      pending: false,
      failed: true,
    });
  });

  test('a thrown read is failed the same way', async () => {
    mocks.getPackGifts.mockRejectedValue(new Error('down'));
    const { result } = await renderHook(ME);
    expect(result.current).toMatchObject({
      held: 0,
      pending: false,
      failed: true,
    });
  });

  test('consume(n) drops the count, floored at 0', async () => {
    mocks.getPackGifts.mockResolvedValue([gift(3)]);
    const { result } = await renderHook(ME);
    await act(async () => result.current.consume(2));
    expect(result.current.held).toBe(1);
    await act(async () => result.current.consume(5));
    expect(result.current.held).toBe(0);
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(1);
  });

  test('invalidate() re-reads (a Retry after a failure clears it)', async () => {
    mocks.getPackGifts
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([gift(1)]);
    const { result } = await renderHook(ME);
    expect(result.current.failed).toBe(true);
    await act(async () => result.current.invalidate());
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      held: 1,
      pending: false,
      failed: false,
    });
  });

  test("a customer switch never shows the last customer's count", async () => {
    mocks.getPackGifts
      .mockResolvedValueOnce([gift(1)])
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = await renderHook(ME);
    expect(result.current.held).toBe(1);
    await rerender({ ...ME, customerId: 'cus_2' });
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ held: 0, pending: true });
  });

  test('a pack switch re-reads for the new pack', async () => {
    mocks.getPackGifts.mockResolvedValue([
      gift(1),
      gift(4, { packId: 'silver' }),
    ]);
    const { result, rerender } = await renderHook(ME);
    expect(result.current.held).toBe(1);
    await rerender({ ...ME, packId: 'silver' });
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(2);
    expect(result.current.held).toBe(4);
  });

  test('a late answer for the previous customer is dropped', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    mocks.getPackGifts
      .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce([]);
    const { result, rerender } = await renderHook(ME);
    await rerender({ ...ME, customerId: 'cus_2' });
    await act(async () => resolveOld([gift(3)]));
    expect(result.current).toMatchObject({ held: 0, pending: false });
  });

  test('logged out: no read, nothing held, nothing pending', async () => {
    const { result } = await renderHook({ ...ME, customerId: null });
    expect(mocks.getPackGifts).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      held: 0,
      pending: false,
      failed: false,
    });
  });
});
