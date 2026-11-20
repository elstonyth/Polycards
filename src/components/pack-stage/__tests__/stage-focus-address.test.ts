import { describe, expect, it } from 'vitest';

import { createFocusAddress } from '../stage-focus-address';

type Entry = { url: string; state: unknown };

/**
 * A browser history: push drops the forward entries, back() is asynchronous
 * (its popstate arrives on `deliver()`), as in a real browser.
 */
function browser(start = '/home-preview') {
  const entries: Entry[] = [{ url: start, state: null }];
  let at = 0;
  let queued = 0;
  const h = {
    get state() {
      return entries[at]!.state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _u: string, url: string) {
      entries.splice(at + 1);
      entries.push({ url, state });
      at++;
    },
    replaceState(state: unknown, _u: string, url: string) {
      entries[at] = { url, state };
    },
    back() {
      queued--;
    },
    forward() {
      queued++;
    },
  };
  const loc = () => ({ pathname: entries[at]!.url, search: '' });
  return {
    h,
    loc,
    url: () => entries[at]!.url,
    length: () => entries.length,
    index: () => at,
    /** The popstate of a queued back() or forward() arrives. */
    deliver() {
      at = Math.max(0, Math.min(entries.length - 1, at + queued));
      queued = 0;
    },
  };
}

describe('focus address: entering', () => {
  it('a tap pushes /slots/<id> (one new entry)', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    expect(b.url()).toBe('/slots/151');
    expect(b.length()).toBe(2);
  });

  it('a scroll replaces the address with /slots/<id> (no new entry)', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    expect(b.url()).toBe('/slots/151');
    expect(b.length()).toBe(1);
  });
});

describe('focus address: leaving the details downwards', () => {
  it('from a pushed entry steps back and adds no entry', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(0);
  });

  it('from a scrolled entry replaces the base path back', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    a.show(false);
    expect(b.url()).toBe('/home-preview');
    expect(b.length()).toBe(1);
  });

  it('coming back up into Closing replaces /slots/<id> again (no new entry)', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    a.show(true);
    expect(b.url()).toBe('/slots/151');
    expect(b.index()).toBe(0);
    expect(b.length()).toBe(2);
  });

  it('down then up before the step back has landed: the address ends on the pack', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    a.show(true); // the back() has not landed yet: nothing is written now
    expect(b.url()).toBe('/slots/151');
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/slots/151');
    expect(b.index()).toBe(0);
  });

  it('a lap (down, up, down, up, then the row) never grows the history', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    for (let i = 0; i < 3; i++) {
      a.show(false);
      a.show(true);
    }
    a.end();
    expect(b.url()).toBe('/home-preview');
    expect(b.length()).toBe(1);
  });
});

describe('focus address: the end at the row', () => {
  it('a tap entry steps back (Back and "All packs" are one move)', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.end();
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
  });

  it('a scrolled entry never steps back off the page', () => {
    const b = browser('/elsewhere');
    b.h.pushState(null, '', '/home-preview');
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    a.end();
    b.deliver();
    expect(a.popped()).toBe(false);
    expect(b.url()).toBe('/home-preview');
    expect(b.length()).toBe(2);
  });

  it('a resumed entry knows whether it was pushed, and its base path', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    // a new document (Back from the pack page) resumes the entry
    const r = createFocusAddress(b.h, b.loc);
    expect(r.resumable()).toBe('151:1');
    r.enter('151', 'resume', '151:1');
    r.end();
    expect(b.url()).toBe('/home-preview');
    expect(b.length()).toBe(1);
  });
});

describe('focus address: popstate', () => {
  it('Forward to the pack while past the details: the address steps back to the base path again', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    b.h.forward();
    b.deliver();
    expect(a.popped()).toBe(false);
    expect(a.onPack()).toBe(true);
    a.show(false);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.length()).toBe(2);
  });

  it('a pop that is not ours is reported as such', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    b.h.back();
    b.deliver();
    expect(a.popped()).toBe(false);
    expect(a.onPack()).toBe(false);
  });
});
