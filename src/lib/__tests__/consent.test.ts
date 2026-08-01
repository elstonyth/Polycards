// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getConsent, setConsent, CONSENT_KEY, CONSENT_EVENT } from '../consent';

describe('consent store', () => {
  beforeEach(() => localStorage.clear());

  it('returns null before any choice', () => {
    expect(getConsent()).toBeNull();
  });

  it('persists and reads back an accepted choice', () => {
    setConsent('accepted');
    expect(getConsent()).toBe('accepted');
    expect(localStorage.getItem(CONSENT_KEY)).toBe('accepted');
  });

  it('ignores an unrecognised stored value', () => {
    localStorage.setItem(CONSENT_KEY, 'garbage');
    expect(getConsent()).toBeNull();
  });

  it('dispatches CONSENT_EVENT after the choice is persisted', () => {
    const spy = vi.fn(() => getConsent());
    window.addEventListener(CONSENT_EVENT, spy);
    setConsent('rejected');
    window.removeEventListener(CONSENT_EVENT, spy);
    expect(spy).toHaveBeenCalledOnce();
    // Listener ran after the write: it already saw the new value.
    expect(spy).toHaveReturnedWith('rejected');
  });

  // Withdrawal path (plan 063 settings-page control): rejecting after a prior
  // accept must overwrite the stored choice and still fire CONSENT_EVENT, so
  // MetaPixel's listener (and the reload the control triggers) both see it.
  it('overwrites an accepted choice with rejected, firing CONSENT_EVENT again', () => {
    setConsent('accepted');
    expect(getConsent()).toBe('accepted');

    const spy = vi.fn(() => getConsent());
    window.addEventListener(CONSENT_EVENT, spy);
    setConsent('rejected');
    window.removeEventListener(CONSENT_EVENT, spy);

    expect(getConsent()).toBe('rejected');
    expect(localStorage.getItem(CONSENT_KEY)).toBe('rejected');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveReturnedWith('rejected');
  });
});
