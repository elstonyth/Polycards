import { describe, expect, it } from 'vitest';
import { BRAND_LOADER_SESSION_KEY } from '@/components/loader/first-visit';
import { STAGE_CRASH_KEY } from '../crash-guard';
import {
  HOME_LOADER_MAX_MS,
  STAGE_LOADER_ATTR,
  STAGE_LOADER_PATHS,
  loaderMaxMs,
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
    styles,
    store: typeof store === 'object' ? store : null,
  };
}

const script = stageLoaderScript();

describe('stage loader pre-paint script', () => {
  it('uses the brand loader session key and the 3D crash key', () => {
    expect(script).toContain(JSON.stringify(BRAND_LOADER_SESSION_KEY));
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

  it('shows the loader on a first visit, marks the session and adds the pre-cover', () => {
    const r = run(script);
    expect(r.shown).toBe(true);
    expect(r.store?.[BRAND_LOADER_SESSION_KEY]).toBe('1');
    expect(r.styles).toHaveLength(1);
    expect(r.styles[0]).toContain(
      'html[data-stage-loader]:not(:has([data-stage-loader-shell]))::before',
    );
  });

  it('shows it once per session', () => {
    const r = run(script, { store: { [BRAND_LOADER_SESSION_KEY]: '1' } });
    expect(r.shown).toBe(false);
    expect(r.styles).toEqual([]);
  });

  it('skips when 3D is not predicted, without spending the session', () => {
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
      expect(r.store?.[BRAND_LOADER_SESSION_KEY], JSON.stringify(env)).toBe(
        undefined,
      );
    }
    expect(run(script, { deviceMemory: 4 }).shown).toBe(true);
  });

  it('skips when storage throws, on read or on write (never a stuck overlay)', () => {
    expect(run(script, { store: 'throws' }).shown).toBe(false);
    expect(run(script, { store: 'setThrows' }).shown).toBe(false);
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
    expect(
      run(script, {
        search: '?loader=alwaysx',
        store: { [BRAND_LOADER_SESSION_KEY]: '1' },
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
