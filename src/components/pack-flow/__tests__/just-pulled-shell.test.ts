// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// When Just Pulled's drawer chunk may load (JustPulledShell's watchNear):
// once the section is within a screen and a half in the layout the visitor
// actually gets. While the flow is off its spacers have no height, so the
// plain page puts the section within reach of the row: a "near" seen then
// must not load the drawer, unless the flow stays off (it is not coming).

vi.mock('@/lib/data/packs', () => ({}));
const { watchNear } = await import('../JustPulledShell');

/** IntersectionObserver as a test double: near() reports every observed
 *  target as within the margin, as a fresh measurement does. */
class FakeIO {
  static all: FakeIO[] = [];
  targets = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback) {
    FakeIO.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
}
function near() {
  for (const io of FakeIO.all)
    for (const target of [...io.targets])
      (io as unknown as { cb: IntersectionObserverCallback }).cb(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        io as unknown as IntersectionObserver,
      );
}

let reduced = false;
let root: HTMLDivElement;
let el: HTMLDivElement;
let stop: () => void;
/** Lets the attribute watch (a MutationObserver: a microtask) see a change. */
const settle = () => Promise.resolve();
async function flow(on: boolean) {
  root.toggleAttribute('data-flow-on', on);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeIO.all = [];
  reduced = false;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  root = document.createElement('div');
  root.setAttribute('data-home-flow', '');
  el = document.createElement('div');
  root.appendChild(el);
  document.body.appendChild(root);
});
afterEach(() => {
  stop?.();
  root.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('watchNear: the drawer loads near the section, never at the row', () => {
  it('ignores the plain layout while the flow is still coming on', () => {
    const onNear = vi.fn();
    stop = watchNear(el, onNear);
    near();
    expect(onNear).not.toHaveBeenCalled();
  });

  it('measures once the flow is on', async () => {
    const onNear = vi.fn();
    stop = watchNear(el, onNear);
    await flow(true);
    near();
    expect(onNear).toHaveBeenCalledTimes(1);
  });

  it('ignores the plain layout while the flow drops out and comes back', async () => {
    const onNear = vi.fn();
    stop = watchNear(el, onNear);
    await flow(true);
    await flow(false); // the focused view's chunk is late: plain scrolling
    near();
    vi.advanceTimersByTime(2000);
    near();
    expect(onNear).not.toHaveBeenCalled();
    await flow(true);
    near();
    expect(onNear).toHaveBeenCalledTimes(1);
  });

  it('measures the plain page once the flow has stayed off for the wait', async () => {
    const onNear = vi.fn();
    stop = watchNear(el, onNear);
    await flow(true);
    await flow(false);
    vi.advanceTimersByTime(5999);
    near();
    expect(onNear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    near();
    expect(onNear).toHaveBeenCalledTimes(1);
  });

  it('measures the plain page when the flow never comes on', () => {
    const onNear = vi.fn();
    stop = watchNear(el, onNear);
    vi.advanceTimersByTime(6000);
    near();
    expect(onNear).toHaveBeenCalledTimes(1);
  });

  it('measures at once without a flow root or under reduced motion', () => {
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    const a = vi.fn();
    const stopA = watchNear(plain, a);
    near();
    expect(a).toHaveBeenCalledTimes(1);
    stopA();
    plain.remove();

    reduced = true;
    const b = vi.fn();
    stop = watchNear(el, b);
    near();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('calls once, and never after cleanup', async () => {
    const onNear = vi.fn();
    stop = watchNear(el, onNear);
    await flow(true);
    near();
    near();
    expect(onNear).toHaveBeenCalledTimes(1);
    const other = vi.fn();
    const stopOther = watchNear(el, other);
    stopOther();
    near();
    vi.advanceTimersByTime(10000);
    expect(other).not.toHaveBeenCalled();
  });
});
