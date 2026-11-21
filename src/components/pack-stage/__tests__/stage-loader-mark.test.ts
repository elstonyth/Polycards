import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  LOGO_LETTERS,
  LOGO_MARK,
  LOGO_VIEWBOX,
} from '@/components/brand/polycards-logo-paths';
import {
  DEFAULT_TIMINGS,
  LETTERS_START_MS,
  LETTER_STAGGER_MS,
  REVEAL_MS,
  STROKE_EASE,
  STROKE_MS,
  STROKE_STAGGER_MS,
  letterOffset,
  pathYExtent,
  splitSubpaths,
} from '@/components/loader/loader-timeline';
import { LOADER_TRAVEL, StageLoaderMark } from '../stage-loader-mark';
import { loaderTimings } from '../stage-loader-script';

// The stage's loader draws the brand mark with CSS from the very first paint
// (no script needed), so it must draw exactly what the brand loader's timeline
// says: the same strokes, delays, curves, the same rising letters and the same
// exit. These tests hold the stylesheet to that timeline.

const css = readFileSync(
  join(process.cwd(), 'src/components/pack-stage/pack-stage.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (norm(m[1] ?? '') === selector) return m[2] ?? '';
  }
  throw new Error(`no rule for ${selector}`);
}
function decl(body: string, prop: string): string {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  if (!m) throw new Error(`no ${prop} in ${body}`);
  return (m[1] ?? '').replace(/\s+/g, ' ').trim();
}
/** The body of `@keyframes name`. */
function keyframes(name: string): string {
  const at = css.indexOf(`@keyframes ${name}`);
  if (at < 0) throw new Error(`no keyframes ${name}`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error('unclosed keyframes');
}
const bezier = (b: readonly number[]) => `cubic-bezier(${b.join(', ')})`;
const EXIT_EASE = bezier([0.4, 0, 0.2, 1]);
const strokes = splitSubpaths(LOGO_MARK);

describe('the CSS-drawn mark follows the brand loader timeline', () => {
  it('draws each stroke over STROKE_MS on the stroke curve, STROKE_STAGGER_MS apart', () => {
    expect(strokes.length).toBeGreaterThan(1);
    const base = rule('.ldMark > path');
    expect(decl(base, 'animation-name')).toBe(
      'stage-ld-stroke, stage-ld-whole',
    );
    expect(decl(base, 'animation-duration')).toBe(`${STROKE_MS}ms, 0s`);
    expect(decl(base, 'animation-timing-function')).toBe(
      `${bezier(STROKE_EASE)}, linear`,
    );
    expect(decl(base, 'animation-fill-mode')).toBe('forwards');
    expect(decl(base, 'animation-delay')).toBe(`0ms, ${STROKE_MS}ms`);
    for (let i = 1; i < strokes.length; i++) {
      const at = i * STROKE_STAGGER_MS;
      expect(
        decl(rule(`.ldMark > path:nth-child(${i + 1})`), 'animation-delay'),
      ).toBe(`${at}ms, ${at + STROKE_MS}ms`);
    }
    const draw = keyframes('stage-ld-stroke').replace(/\s+/g, ' ');
    expect(draw).toMatch(
      /from \{ visibility: visible; stroke-dasharray: 0 2; \}/,
    );
    expect(draw).toMatch(
      /to \{ visibility: visible; stroke-dasharray: 1 2; \}/,
    );
    // whole: the dash goes, so a closed outline keeps its mitred start corner
    expect(keyframes('stage-ld-whole').replace(/\s+/g, ' ')).toMatch(
      /(from|to) \{ visibility: visible; stroke-dasharray: none; \}/,
    );
  });

  it('raises each letter from LOADER_TRAVEL below, LETTER_STAGGER_MS apart, on the spring', () => {
    const ext = LOGO_LETTERS.map((l) => pathYExtent(l.d));
    const cut = Math.max(...ext.map((e) => e.maxY)) + 1.5;
    expect(LOADER_TRAVEL).toBeCloseTo(
      cut - Math.min(...ext.map((e) => e.minY)) + 1.5,
      6,
    );
    const base = rule('.ldLetters > g > path');
    expect(decl(base, 'transform')).toBe(`translateY(${LOADER_TRAVEL}px)`);
    expect(decl(base, 'animation-name')).toBe('stage-ld-rise');
    expect(decl(base, 'animation-duration')).toBe(
      `${REVEAL_MS - LETTERS_START_MS}ms`,
    );
    expect(decl(base, 'animation-fill-mode')).toBe('forwards');
    expect(decl(base, 'animation-delay')).toBe(`${LETTERS_START_MS}ms`);
    for (let i = 1; i < LOGO_LETTERS.length; i++)
      expect(
        decl(
          rule(`.ldLetters > g:nth-child(${i + 1}) > path`),
          'animation-delay',
        ),
      ).toBe(`${LETTERS_START_MS + i * LETTER_STAGGER_MS}ms`);
    // The rise is the letters' spring, stop for stop (keyframe stops with
    // linear steps, which every browser we serve plays): within 0.1 viewBox
    // units of the timeline at every moment of the rise.
    expect(decl(base, 'animation-timing-function')).toBe('linear');
    const stops = [
      ...keyframes('stage-ld-rise').matchAll(
        /([\d.]+)%\s*\{\s*transform:\s*translateY\((-?[\d.]+)(?:px)?\);\s*\}/g,
      ),
    ].map((m) => ({ x: Number(m[1]) / 100, y: Number(m[2]) }));
    expect(stops.length).toBeGreaterThan(10);
    expect(stops[0]).toEqual({ x: 0, y: LOADER_TRAVEL });
    expect(stops.at(-1)).toEqual({ x: 1, y: 0 });
    const at = (x: number) => {
      const k = stops.findIndex((p) => p.x >= x);
      const b = stops[k];
      const a = stops[Math.max(0, k - 1)];
      if (!a || !b) return 0;
      return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
    };
    const span = REVEAL_MS - LETTERS_START_MS;
    let worst = 0;
    for (let i = 0; i < LOGO_LETTERS.length; i++) {
      const start = LETTERS_START_MS + i * LETTER_STAGGER_MS;
      for (let t = start; t <= REVEAL_MS + 400; t += 2) {
        const css = at(Math.min(1, (t - start) / span));
        const want = letterOffset(i, t) * LOADER_TRAVEL;
        worst = Math.max(worst, Math.abs(css - want));
      }
    }
    expect(worst).toBeLessThan(0.1);
  });

  it('leaves like the brand loader: the cover fades, the logo lifts 10 px and fades a touch sooner', () => {
    const exit = DEFAULT_TIMINGS.exitMs;
    expect(decl(rule('.ldCover'), 'transition')).toBe(
      `opacity ${exit}ms ${EXIT_EASE}`,
    );
    expect(decl(rule('.ldCover[data-leaving]'), 'opacity')).toBe('0');
    expect(decl(rule('.ldLogo'), 'transition')).toBe(
      `opacity ${exit * 0.9}ms ${EXIT_EASE}, transform ${exit}ms ${EXIT_EASE}`,
    );
    const gone = rule('.ldCover[data-leaving] .ldLogo');
    expect(decl(gone, 'opacity')).toBe('0');
    expect(decl(gone, 'transform')).toBe('translateY(-10px)');
  });
});

describe('the mark in the server render', () => {
  const html = renderToStaticMarkup(createElement(StageLoaderMark));

  it('is the brand loader overlay: a full-screen ink cover with the logo in the middle', () => {
    expect(html).toMatch(/^<div role="status" aria-label="Loading Polycards"/);
    expect(html).toContain(
      'fixed inset-0 z-[1000] flex items-center justify-center bg-neutral-950 text-white',
    );
    expect(html).toContain('w-[60vw] max-w-[26rem]');
    expect(html).toContain(`viewBox="${LOGO_VIEWBOX}"`);
    expect(html).not.toContain('data-leaving');
  });

  it('holds every stroke hidden and normalised, and every letter in its own clip column', () => {
    expect(html.match(/pathLength="1" visibility="hidden"/g)).toHaveLength(
      strokes.length,
    );
    for (let i = 0; i < LOGO_LETTERS.length; i++)
      expect(html).toContain(`clip-path="url(#stage-ld-l${i})"`);
    expect(html.match(/<clipPath /g)).toHaveLength(LOGO_LETTERS.length);
  });
});

describe('the hand-over to the hydrated loader', () => {
  it('keeps the reveal running from where the CSS clock is, and keeps the caps', () => {
    // hydrated at 300 ms, the mark drawing for 180 ms: the reveal ends 1420 ms on
    expect(loaderTimings(300, 180)).toEqual({
      minMs: REVEAL_MS - 180,
      maxMs: 2700,
      exitMs: DEFAULT_TIMINGS.exitMs,
    });
    // a reveal already over waits for nothing; the cap never drops under 800 ms
    expect(loaderTimings(2500, 2400)).toEqual({
      minMs: 0,
      maxMs: 800,
      exitMs: DEFAULT_TIMINGS.exitMs,
    });
    // no CSS clock to read: the whole reveal from now
    expect(loaderTimings(400, null).minMs).toBe(REVEAL_MS);
  });
});
