import { describe, expect, it } from 'vitest';

import {
  FOCUS_MARK,
  FOCUS_STEP_MS,
  createFocusAddress,
} from '../stage-focus-address';
import { startEntry } from '../stage-focus-entry';

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

  it("coming back up into Closing steps forward onto the tap's entry (no new entry)", () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    a.show(true);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/slots/151');
    expect(b.index()).toBe(1);
    expect(b.length()).toBe(2);
  });

  it('coming back up into Closing from a scrolled entry replaces /slots/<id> again', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    a.show(false);
    a.show(true);
    expect(b.url()).toBe('/slots/151');
    expect(b.index()).toBe(0);
    expect(b.length()).toBe(1);
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
    // landed on the row: one step forward onto the pack's entry again
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/slots/151');
    expect(b.index()).toBe(1);
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

describe('focus address: Back then Forward during the leave (review 1)', () => {
  it('the entry Forward brought back is reported as strayed once the focus has ended', () => {
    const b = browser('/elsewhere');
    b.h.pushState(null, '', '/home-preview');
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    // browser Back: the page starts its leave and forgets the entry
    b.h.back();
    b.deliver();
    expect(a.popped()).toBe(false);
    a.forget();
    // Forward during the leave brings the pack's entry back
    b.h.forward();
    b.deliver();
    expect(a.popped()).toBe(false);
    // the leave lands at the row
    a.end();
    expect(b.url()).toBe('/slots/151');
    expect(a.strayed()).toBe(true);
    // the page resumes that entry (a new focus), and its end steps back
    a.enter('151', 'resume', '151:1');
    expect(a.strayed()).toBe(false);
    a.end();
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(1);
  });

  it('an ordinary end is never strayed (its step back is pending, or the base path is back)', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.end();
    expect(a.strayed()).toBe(false);
    b.deliver();
    a.popped();
    expect(a.strayed()).toBe(false);
    const c = browser();
    const s = createFocusAddress(c.h, c.loc);
    s.enter('151', 'scroll', '151:2');
    s.end();
    expect(s.strayed()).toBe(false);
  });
});

describe('focus address: a new focus before the step back has landed (review 2)', () => {
  it('keeps the base path and writes once the step back lands', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.end(); // the leave landed: one step back, not yet arrived
    a.enter('151', 'scroll', '151:2'); // a wheel notch focuses again
    // nothing is written while the step back is pending
    expect(b.url()).toBe('/slots/151');
    expect(b.index()).toBe(1);
    b.deliver();
    expect(a.popped()).toBe(true);
    // the row's own entry now shows the pack (a scroll entry: replaced)
    expect(b.index()).toBe(0);
    expect(b.url()).toBe('/slots/151');
    // a lap and the end: the base path, never the pack's
    a.show(false);
    expect(b.url()).toBe('/home-preview');
    a.show(true);
    expect(b.url()).toBe('/slots/151');
    a.end();
    expect(b.url()).toBe('/home-preview');
  });

  it('a tap that lands before the step back pushes once it has', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.end();
    a.enter('151', 'tap', '151:2');
    expect(b.index()).toBe(1);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.index()).toBe(1);
    expect(b.url()).toBe('/slots/151');
    a.end();
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(0);
  });

  it('a new focus left again before the step back lands writes nothing', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.end();
    a.enter('151', 'scroll', '151:2');
    a.show(false);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(0);
  });
});

describe('focus address: Back after a lap still unfocuses (review 6)', () => {
  it('coming back up steps forward onto the pushed entry instead of replacing the row', () => {
    const b = browser('/elsewhere');
    b.h.pushState(null, '', '/home-preview');
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.index()).toBe(1);
    a.show(true);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/slots/151');
    expect(b.index()).toBe(2);
    expect(b.length()).toBe(3);
    // browser Back from here lands on the row, not before the page
    b.h.back();
    b.deliver();
    expect(a.popped()).toBe(false);
    expect(b.url()).toBe('/home-preview');
  });

  it('down again before the step forward lands: the address ends on the base path', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    a.show(true); // forward pending
    a.show(false);
    b.deliver();
    expect(a.popped()).toBe(true);
    // landed on the pack: stepped back again
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(0);
  });

  it('the end while the step forward is pending: the address ends on the base path', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    a.show(true);
    a.end();
    expect(a.entry()).toBeNull();
    b.deliver();
    expect(a.popped()).toBe(true);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(0);
  });

  it('a pop that is not ours in between: replaces instead (the forward entry is not known)', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    // the visitor goes Forward and Back themselves
    b.h.forward();
    b.deliver();
    expect(a.popped()).toBe(false);
    a.show(false);
    b.deliver();
    a.popped();
    b.h.pushState(null, '', '/home-preview?x=1'); // something pushed: the forward entry is gone
    b.h.back();
    b.deliver();
    expect(a.popped()).toBe(false);
    a.show(true);
    // replaced at once: no step forward that could never arrive
    expect(b.url()).toBe('/slots/151');
    expect(b.length()).toBe(2);
  });

  it('after a forget or in a new document nothing is stepped forward', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    const r = createFocusAddress(b.h, b.loc);
    r.enter('151', 'tap', '151:2');
    // the new document's own entry: pushed fresh, no forward step
    expect(b.index()).toBe(1);
    expect(b.length()).toBe(2);
    r.forget();
    r.show(true);
    expect(b.index()).toBe(1);
  });
});

describe('focus address: a step forward that never lands', () => {
  it('another script pushed meanwhile (no popstate): after the time limit the address is replaced instead', () => {
    const b = browser();
    const timers: (() => void)[] = [];
    const a = createFocusAddress(b.h, b.loc, (_ms, fn) => {
      timers.push(fn);
      return () => {};
    });
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    // something pushes an entry of its own: the forward entry is gone
    b.h.pushState({ other: true }, '', '/home-preview');
    a.show(true); // a step forward is asked for; it can never arrive
    b.deliver();
    expect(b.url()).toBe('/home-preview');
    // the time limit passes: the pack's address is written in place
    timers.at(-1)!();
    expect(b.url()).toBe('/slots/151');
    // the address keeps working: down again replaces the base path back
    a.show(false);
    expect(b.url()).toBe('/home-preview');
    // and the visitor's own Back is never taken for ours
    b.h.back();
    b.deliver();
    expect(a.popped()).toBe(false);
  });

  it('a step forward that lands in time disarms the time limit', () => {
    const b = browser();
    const timers: { fn: () => void; off: boolean }[] = [];
    const a = createFocusAddress(b.h, b.loc, (ms, fn) => {
      expect(ms).toBe(FOCUS_STEP_MS);
      const t = { fn, off: false };
      timers.push(t);
      return () => {
        t.off = true;
      };
    });
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    a.show(true);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(timers.at(-1)!.off).toBe(true);
    expect(b.index()).toBe(1);
  });
});

describe('focus address: guards', () => {
  it('a cleanup after a link navigation never steps back off the new page', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    b.h.pushState(null, '', '/about'); // a link opened another page
    a.end();
    b.deliver();
    expect(b.url()).toBe('/about');
    expect(b.length()).toBe(3);
  });

  it('an entry at the pack path that is not ours is replaced, never stepped back', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    b.h.replaceState({ __flow: 'other', __flowPushed: true }, '', '/slots/151');
    a.show(false);
    b.deliver();
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(1);
  });

  it('after browser Back the forgotten focus writes nothing more', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    b.h.back();
    b.deliver();
    a.popped();
    a.forget();
    a.show(false);
    a.show(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.length()).toBe(2);
  });
});

describe('focus address: a pick in the lineup', () => {
  it("coming back up after a pick steps onto the tap's entry and shows the picked pack there", () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    a.pack('mega');
    // nothing is written while the address shows the base path
    expect(b.url()).toBe('/home-preview');
    a.show(true);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/slots/mega');
    expect(b.index()).toBe(1);
    expect(b.length()).toBe(2);
    expect(a.onPack()).toBe(true);
  });

  it('after a pick the entry is still the pushed one: leaving again steps back, no entry added', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    b.deliver();
    a.popped();
    a.pack('mega');
    a.show(true);
    b.deliver();
    a.popped();
    a.show(false);
    b.deliver();
    expect(a.popped()).toBe(true);
    expect(b.url()).toBe('/home-preview');
    expect(b.index()).toBe(0);
    expect(b.length()).toBe(2);
  });

  it('a scrolled entry: coming back up after a pick replaces the picked pack', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    a.show(false);
    a.pack('mega');
    a.show(true);
    expect(b.url()).toBe('/slots/mega');
    expect(b.length()).toBe(1);
  });

  it('a pick before the step back has landed: coming back up still shows the picked pack', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'tap', '151:1');
    a.show(false);
    a.pack('mega');
    a.show(true);
    b.deliver();
    a.popped();
    // the step back landed; the address is brought to the pack, as asked
    b.deliver();
    a.popped();
    expect(b.url()).toBe('/slots/mega');
    expect(b.length()).toBe(2);
  });

  it('a pick while the address shows the pack replaces it in place', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.enter('151', 'scroll', '151:1');
    a.pack('mega');
    expect(b.url()).toBe('/slots/mega');
    expect(b.length()).toBe(1);
  });

  it('no focus: a pick writes nothing', () => {
    const b = browser();
    const a = createFocusAddress(b.h, b.loc);
    a.pack('mega');
    expect(b.url()).toBe('/home-preview');
  });
});

describe('focus address: a load straight onto a pack address', () => {
  /** The flow page as the pack route serves it for a load onto 151. */
  const landed = (search = '?focus=151') => {
    const b = browser('/home-preview');
    const loc = b.loc;
    let s = search;
    const l = () => ({ ...loc(), search: s });
    b.h.replaceState = ((orig) => (st: unknown, u: string, url: string) => {
      const [p, qs] = url.split('?');
      s = qs ? `?${qs}` : '';
      orig(st, u, p!);
    })(b.h.replaceState.bind(b.h));
    return { b, l };
  };
  const start = (x: ReturnType<typeof landed>, now = 1000, id = '151') =>
    startEntry(x.b.h, x.l(), {
      id,
      base: '/home-preview',
      now,
    });

  it("puts the pack's address back and marks the entry in place (no new entry)", () => {
    const x = landed();
    const mark = start(x);
    expect(mark).toBe('151:start:1000');
    expect(x.b.length()).toBe(1);
    expect(x.b.url()).toBe('/slots/151');
    expect(x.l().search).toBe('');
    const a = createFocusAddress(x.b.h, x.b.loc);
    expect(a.resumable()).toBe(mark);
  });

  it('keeps the other query (QA switches) on the address', () => {
    const x = landed('?stage=3d&focus=151');
    start(x);
    expect(x.b.url()).toBe('/slots/151');
    expect(x.l().search).toBe('?stage=3d');
  });

  it('keeps what the router already stored in the entry', () => {
    const x = landed();
    x.b.h.replaceState(
      { __NA: true, tree: 'x' },
      '',
      '/home-preview?focus=151',
    );
    start(x);
    expect(x.b.h.state).toMatchObject({ __NA: true, tree: 'x' });
  });

  it('a reload gets a fresh mark, so it opens on Front (no saved stop)', () => {
    const x = landed();
    const first = start(x, 1000);
    const again = start(landed(), 2000);
    expect(again).toBe('151:start:2000');
    expect(again).not.toBe(first);
  });

  it('a reload of a tapped entry is no longer a pushed one: going up from Front replaces the address in place', () => {
    const x = landed();
    x.b.h.replaceState(
      {
        [FOCUS_MARK]: '151:1',
        __flowPushed: true,
        __flowBase: '/home-preview',
      },
      '',
      '/home-preview?focus=151',
    );
    const mark = start(x, 3000)!;
    expect(mark).toBe('151:start:3000');
    const r = createFocusAddress(x.b.h, x.b.loc);
    r.enter('151', 'resume', mark);
    r.end();
    expect(x.b.url()).toBe('/home-preview');
    expect(x.b.length()).toBe(1);
  });

  it('an old mark in the entry is never reused: every load opens on Front', () => {
    const x = landed();
    x.b.h.replaceState(
      { [FOCUS_MARK]: '151:9', __flowPushed: true, __flowBase: '/' },
      '',
      '/home-preview?focus=151',
    );
    expect(start(x, 4000)).toBe('151:start:4000');
    expect(x.b.h.state).not.toHaveProperty('__flowPushed');
    expect(x.b.url()).toBe('/slots/151');
    expect(x.b.h.state).toMatchObject({
      [FOCUS_MARK]: '151:start:4000',
      __flowBase: '/',
    });
  });

  it('going up from Front puts the base path in place: Back then leaves the site', () => {
    const x = landed();
    const mark = start(x)!;
    const a = createFocusAddress(x.b.h, x.b.loc);
    a.enter('151', 'resume', mark);
    a.show(true);
    expect(x.b.url()).toBe('/slots/151');
    a.end();
    expect(x.b.url()).toBe('/home-preview');
    expect(x.b.length()).toBe(1);
    expect(x.b.index()).toBe(0);
  });

  it('writes nothing when the load is not one onto that pack', () => {
    const x = landed('');
    expect(start(x)).toBeNull();
    expect(x.b.h.state).toBeNull();
    const y = landed('?focus=ah');
    expect(start(y)).toBeNull();
    expect(y.b.url()).toBe('/home-preview');
  });

  it('encodes the id in the address', () => {
    const x = landed('?focus=a%20b');
    expect(start(x, 5, 'a b')).toBe('a b:start:5');
    expect(x.b.url()).toBe('/slots/a%20b');
  });
});
