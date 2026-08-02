// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { lockBodyScroll, unlockBodyScroll } from '../use-modal-a11y';

// The lock's refcount + preLockOverflow are module-level state (by design —
// see the comment in use-modal-a11y.ts), so a failed assertion mid-test could
// leave the count unbalanced and leak into the next case. scrollLockCount
// isn't exported (only the two functions are), so force-drain it: extra
// unlockBodyScroll() calls past zero are a documented no-op (Math.max(0, …)).
afterEach(() => {
  for (let i = 0; i < 5; i++) unlockBodyScroll();
  document.body.style.overflow = '';
});

describe('body scroll lock (refcounted, shared by useModalA11y + useChromeInert)', () => {
  it('lock then unlock restores the original overflow value', () => {
    document.body.style.overflow = '';
    lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');
    unlockBodyScroll();
    expect(document.body.style.overflow).toBe('');
  });

  it('out-of-order interleaving (chrome locks, modal locks, chrome unlocks, modal unlocks) still restores the original value', () => {
    // This is the exact sequence that used to strand body{overflow:hidden}:
    // a parent effect (chrome-inert) tearing down before a still-open child's
    // (modal) — see plan 075.
    document.body.style.overflow = '';
    lockBodyScroll(); // chrome
    lockBodyScroll(); // modal
    expect(document.body.style.overflow).toBe('hidden');
    unlockBodyScroll(); // chrome unlocks first
    expect(document.body.style.overflow).toBe('hidden'); // modal still open
    unlockBodyScroll(); // modal unlocks last
    expect(document.body.style.overflow).toBe('');
  });

  it('double-unlock does not go negative and does not clobber a later lock', () => {
    document.body.style.overflow = '';
    lockBodyScroll();
    unlockBodyScroll();
    unlockBodyScroll(); // extra unlock past zero — must not underflow the count
    expect(document.body.style.overflow).toBe('');

    // A fresh lock afterward must still behave like a normal first lock.
    lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');
    unlockBodyScroll();
    expect(document.body.style.overflow).toBe('');
  });

  it('captures the pre-lock value at the FIRST lock only', () => {
    document.body.style.overflow = '';
    lockBodyScroll(); // A — captures '' as the value to restore
    document.body.style.overflow = 'hidden'; // simulates a nested lock's own write
    lockBodyScroll(); // B — must NOT re-capture 'hidden' as the restore value
    unlockBodyScroll(); // A
    unlockBodyScroll(); // B — count hits zero, restores the value captured at A
    expect(document.body.style.overflow).toBe('');
  });
});
