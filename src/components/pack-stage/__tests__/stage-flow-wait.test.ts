// @vitest-environment jsdom
import { act } from 'react';
import { renderHook } from '@/lib/__tests__/render-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_WAIT_CAP_MS, useFlowWait } from '../stage-flow-wait';

// Just Pulled's drawer waits for the flow while it is on its way; a flow that
// never binds stops the wait after the cap.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useFlowWait: the wait for the flow', () => {
  it('pending at first, given up once the cap passes with no bind', () => {
    const result = renderHook(() => useFlowWait(), undefined);
    expect(result.current.wait).toBe('pending');
    act(() => vi.advanceTimersByTime(FLOW_WAIT_CAP_MS - 1));
    expect(result.current.wait).toBe('pending');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.wait).toBe('gave-up');
  });

  it('the cap is 15 s', () => {
    expect(FLOW_WAIT_CAP_MS).toBe(15_000);
  });

  it('a bind before the cap ends the wait for good', () => {
    const result = renderHook(() => useFlowWait(), undefined);
    act(() => result.current.bound());
    expect(result.current.wait).toBeNull();
    act(() => vi.advanceTimersByTime(FLOW_WAIT_CAP_MS * 2));
    expect(result.current.wait).toBeNull();
  });

  it('a bind after the cap still hands the switch to the flow', () => {
    const result = renderHook(() => useFlowWait(), undefined);
    act(() => vi.advanceTimersByTime(FLOW_WAIT_CAP_MS));
    act(() => result.current.bound());
    expect(result.current.wait).toBeNull();
  });

  it('a failed chunk gives up at once', () => {
    const result = renderHook(() => useFlowWait(), undefined);
    act(() => result.current.failed());
    expect(result.current.wait).toBe('gave-up');
  });

  it('unmounting clears the timer', () => {
    const { unmount } = renderHook(() => useFlowWait(), undefined);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
