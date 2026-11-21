// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryPlaced, pendingEntry } from '../stage-entry-cover';
import { FLOW_ENTRY_ATTR } from '../stage-loader-script';

// The stage resumes a focus entry with no move only while the document's own
// load onto the pack's address is still being placed under the loader; any
// later resume (the stage mounted again, Back from the reel) moves as usual.

afterEach(() => document.documentElement.removeAttribute(FLOW_ENTRY_ATTR));

describe('the pending entry of a load onto a pack address', () => {
  it("the document's load onto the address: pending, with its pack", () => {
    document.documentElement.setAttribute(FLOW_ENTRY_ATTR, '151');
    expect(pendingEntry()).toBe('151');
  });

  it('once placed, never pending again in this document', () => {
    document.documentElement.setAttribute(FLOW_ENTRY_ATTR, '151');
    entryPlaced();
    expect(pendingEntry()).toBeNull();
  });

  it('a plain load has none', () => {
    expect(pendingEntry()).toBeNull();
  });
});

describe("the flow's binds in one document", () => {
  /** A fresh document: the module as a new page load gets it. */
  const fresh = async () => {
    vi.resetModules();
    return import('../stage-entry-cover');
  };

  it('only the first bind places a focus entry with no move', async () => {
    const { placeInstantly } = await fresh();
    expect(placeInstantly()).toBe(true);
    // Back from the reel, or the stage mounted again: the usual move
    expect(placeInstantly()).toBe(false);
    expect(placeInstantly()).toBe(false);
  });

  it('the first bind is instant even when no loader covers the load', async () => {
    const { placeInstantly } = await fresh();
    expect(pendingEntry()).toBeNull();
    expect(placeInstantly()).toBe(true);
  });

  it('a bind again before the pack is placed still places it under the cover', async () => {
    const m = await fresh();
    document.documentElement.setAttribute(FLOW_ENTRY_ATTR, '151');
    expect(m.placeInstantly()).toBe(true);
    expect(m.placeInstantly()).toBe(true);
    m.entryPlaced();
    expect(m.placeInstantly()).toBe(false);
  });
});
