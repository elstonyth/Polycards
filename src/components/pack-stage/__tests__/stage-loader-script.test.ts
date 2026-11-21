import { describe, expect, it } from 'vitest';
import { BRAND_LOADER_SESSION_KEY } from '@/components/loader/first-visit';
import { STAGE_CRASH_KEY } from '../crash-guard';
import {
  ENTRY_LOADER_MAX_MS,
  FLOW_COVER_ATTR,
  FLOW_ENTRY_ATTR,
  HOME_LOADER_MAX_MS,
  STAGE_LOADER_ATTR,
  STAGE_LOADER_PATHS,
  loaderMaxMs,
  flowEntryScript,
  stageLoaderScript,
} from '../stage-loader-script';

type Env = {
  path?: string;
  search?: string;
  store?: Record<string, string> | 'throws' | 'setThrows';
  reducedMotion?: boolean;
  reducedData?: boolean;
  saveData?: boolean;
  deviceMemory?: number;
};

/** Runs the inline script against a fake window and reports what it did. */
function run(script: string, env: Env = {}) {
  const store = env.store === undefined ? {} : env.store;
  const attrs: Record<string, string> = {};
  const styles: string[] = [];
  const sessionStorage = {
    getItem: (k: string) =>
      typeof store === 'object' && k in store ? (store[k] ?? null) : null,
    setItem: (k: string, v: string) => {
      if (store === 'setThrows') throw new Error('QuotaExceededError');
      if (typeof store === 'object') store[k] = v;
    },
  };
  const window = {
    location: {
      pathname: env.path ?? '/home-preview',
      search: env.search ?? '',
    },
    get sessionStorage() {
      if (store === 'throws') throw new Error('SecurityError');
      return sessionStorage;
    },
    matchMedia: (q: string) => ({
      matches:
        (q.includes('reduced-motion') && env.reducedMotion === true) ||
        (q.includes('reduced-data') && env.reducedData === true),
    }),
  };
  const navigator = {
    connection: env.saveData ? { saveData: true } : undefined,
    deviceMemory: env.deviceMemory,
  };
  const document = {
    createElement: () => ({ textContent: '' }),
    head: {
      appendChild: (el: { textContent: string }) => styles.push(el.textContent),
    },
    documentElement: {
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
    },
  };
  new Function('window', 'navigator', 'document', script)(
    window,
    navigator,
    document,
  );
  return {
    shown: attrs[STAGE_LOADER_ATTR] === '1',
    entry: attrs[FLOW_ENTRY_ATTR] ?? null,
    styles,
    store: typeof store === 'object' ? store : null,
  };
}

const script = stageLoaderScript();

describe('stage loader pre-paint script', () => {
  it('reads the 3D crash key and never touches the old session key', () => {
    expect(script).not.toContain(JSON.stringify(BRAND_LOADER_SESSION_KEY));
    expect(script).not.toContain('setItem');
    expect(script).toContain(JSON.stringify(STAGE_CRASH_KEY));
    expect(STAGE_LOADER_ATTR).toBe('data-stage-loader');
    expect(script).not.toMatch(/<\/script/i);
  });

  it('acts on the stage preview only', () => {
    expect(STAGE_LOADER_PATHS).toEqual(['/home-preview']);
    expect(run(script, { path: '/home-preview' }).shown).toBe(true);
    expect(run(script, { path: '/home-preview/' }).shown).toBe(true);
  });

  it('does nothing at all on any other path', () => {
    for (const path of [
      '/',
      '/slots',
      '/slots/gold-pack',
      '/home-preview/x',
      '/home-previews',
      '/loader-preview',
      '/vault',
    ]) {
      const r = run(script, { path, search: '?loader=always' });
      expect(r.shown, path).toBe(false);
      expect(r.styles, path).toEqual([]);
      expect(r.store, path).toEqual({});
    }
  });

  it('shows the loader on a first visit and adds the pre-cover, writing nothing', () => {
    const r = run(script);
    expect(r.shown).toBe(true);
    expect(r.store).toEqual({});
    expect(r.styles).toHaveLength(1);
    expect(r.styles[0]).toContain(
      'html[data-stage-loader]:not(:has([data-stage-loader-shell]))::before',
    );
  });

  it('shows it on every document load: a refresh or a second open in the same session too (owner, 2026-11-21)', () => {
    const r = run(script, { store: { [BRAND_LOADER_SESSION_KEY]: '1' } });
    expect(r.shown).toBe(true);
    expect(r.styles).toHaveLength(1);
  });

  it('skips when 3D is not predicted', () => {
    for (const env of [
      { reducedMotion: true },
      { reducedData: true },
      { saveData: true },
      { deviceMemory: 2 },
      { deviceMemory: 0.5 },
      { store: { [STAGE_CRASH_KEY]: 'boot' } },
      { store: { [STAGE_CRASH_KEY]: 'crashed' } },
    ] satisfies Env[]) {
      const r = run(script, env);
      expect(r.shown, JSON.stringify(env)).toBe(false);
    }
    expect(run(script, { deviceMemory: 4 }).shown).toBe(true);
  });

  it('skips when storage cannot be read (never a stuck overlay); a full store is no reason to skip', () => {
    expect(run(script, { store: 'throws' }).shown).toBe(false);
    expect(run(script, { store: 'setThrows' }).shown).toBe(true);
  });

  it('honours the preview overrides from the URL', () => {
    expect(run(script, { search: '?loader=never' }).shown).toBe(false);
    expect(
      run(script, {
        search: '?debug=1&loader=always',
        store: { [BRAND_LOADER_SESSION_KEY]: '1' },
        reducedMotion: true,
      }).shown,
    ).toBe(true);
    expect(
      run(script, { search: '?loader=always', store: 'throws' }).shown,
    ).toBe(false);
    // an unknown value is no override: the usual checks decide
    expect(
      run(script, {
        search: '?loader=alwaysx',
        reducedMotion: true,
      }).shown,
    ).toBe(false);
  });
});

describe('loader hold cap', () => {
  it('is 3000 ms from navigation start, never under 800 ms after mount', () => {
    expect(HOME_LOADER_MAX_MS).toBe(3000);
    expect(loaderMaxMs(400)).toBe(2600);
    expect(loaderMaxMs(2500)).toBe(800);
    expect(loaderMaxMs(9000)).toBe(800);
  });
});

describe("the layout's pre-paint script never handles a pack's address", () => {
  it('reads no focus and never marks an entry: the head of every page stays as it was', () => {
    expect(script).not.toContain('focus');
    expect(script).not.toContain(FLOW_ENTRY_ATTR);
    expect(run(script, { search: '?focus=151' }).entry).toBeNull();
  });
});

/** Runs the flow page's entry script against a fake window. */
function runEntry(
  id: string,
  env: { loader?: boolean; reducedMotion?: boolean } = {},
) {
  const attrs: Record<string, string> = env.loader
    ? { [STAGE_LOADER_ATTR]: '1' }
    : {};
  const styles: string[] = [];
  const replaced: string[] = [];
  const window = {
    location: { replace: (to: string) => replaced.push(to) },
    matchMedia: (q: string) => ({
      matches: q.includes('reduced-motion') && env.reducedMotion === true,
    }),
  };
  const document = {
    createElement: () => ({ textContent: '' }),
    head: {
      appendChild: (el: { textContent: string }) => styles.push(el.textContent),
    },
    documentElement: {
      hasAttribute: (k: string) => k in attrs,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
    },
  };
  new Function(
    'window',
    'document',
    flowEntryScript(id, `/slots/${encodeURIComponent(id)}?count=1`),
  )(window, document);
  return {
    entry: attrs[FLOW_ENTRY_ATTR] ?? null,
    cover: FLOW_COVER_ATTR in attrs,
    styles,
    replaced,
  };
}

describe("the flow page's script for a load onto a pack's address", () => {
  it('a load the loader covers is marked with the pack being placed', () => {
    expect(runEntry('151', { loader: true }).entry).toBe('151');
    expect(runEntry('151', { loader: true }).cover).toBe(true);
    expect(runEntry('a b', { loader: true }).entry).toBe('a b');
    expect(runEntry('151', { loader: true }).replaced).toEqual([]);
  });

  it('a load with no loader is never marked', () => {
    const r = runEntry('151');
    expect(r.entry).toBeNull();
    expect(r.cover).toBe(false);
    expect(r.styles).toEqual([]);
  });

  it("reduced motion takes today's pack page and is never marked", () => {
    const r = runEntry('151', { loader: true, reducedMotion: true });
    expect(r.replaced).toEqual(['/slots/151?count=1']);
    expect(r.entry).toBeNull();
  });

  it("holds the pre-cover until the entry's own limit", () => {
    const [css] = runEntry('151', { loader: true }).styles;
    expect(css).toContain(`html[${FLOW_COVER_ATTR}][${STAGE_LOADER_ATTR}]`);
    expect(css).toContain(`animation-delay:${ENTRY_LOADER_MAX_MS / 1000 + 1}s`);
  });

  it('cannot be broken out of by a pack id', () => {
    expect(flowEntryScript('</script><b>', '/slots/x')).not.toContain('<');
  });
});
