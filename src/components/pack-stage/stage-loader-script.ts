/**
 * The stage's pre-paint loader gate, as the source of a tiny inline `<script>`
 * the root layout emits in `<head>` (before anything paints; inert on every
 * path but STAGE_LOADER_PATHS). It decides whether this document load shows
 * the brand loader: if so it sets `html[data-stage-loader]`, which is the only
 * thing that makes the loader shell visible (pack-stage.module.css).
 *
 * The loader shows on every full document load (a first visit, a refresh, a
 * cold open from the home-screen icon) when ALL hold: the cheap gate predicts
 * 3D (no reduced motion, no save-data, no crash flag, not `deviceMemory <= 2`)
 * and session storage can be read. It writes nothing. Any throw skips the
 * loader: a pre-hydration overlay must never risk sticking.
 *
 * Server-safe: builds a string, runs nothing.
 */
import {
  DEFAULT_TIMINGS,
  REVEAL_MS,
  type LoaderTimings,
} from '@/components/loader/loader-timeline';
import { STAGE_CRASH_KEY } from './crash-guard';

/** The loader's hold cap, in ms from NAVIGATION start (not from hydration). */
export const HOME_LOADER_MAX_MS = 3000;
/**
 * A load onto a pack's own address (`?focus=<id>`) keeps the cover until the
 * flow has placed the pack on its stop, up to this (ms from navigation start),
 * then takes today's pack page. Measured on a throttled phone (400 ms latency,
 * 200 KB/s) the pack was placed at 14.5 s; past this the visitor is better
 * served by the plain pack page. The flow's own wait gives up at the same time.
 */
export const ENTRY_LOADER_MAX_MS = 15_000;

/**
 * The html attribute the script sets on such a load, holding the pack's id;
 * the flow removes it once the pack rests on its stop.
 */
export const FLOW_ENTRY_ATTR = 'data-flow-entry';

/**
 * Set with it and kept for the whole document (the placement never removes
 * it): the cover's failsafes wait for ENTRY_LOADER_MAX_MS on such a load.
 */
export const FLOW_COVER_ATTR = 'data-flow-cover';

/**
 * Set once such a load has gone for today's pack page: the cover stays, its
 * failsafe off, until that page replaces this one.
 */
export const FLOW_LEAVE_ATTR = 'data-flow-leave';

/** Never cut the loader's exit shorter than this after it mounts. */
const MIN_HOLD_MS = 800;

/** A page hydrating after this (ms from navigation start) lets the loader go
 *  at once: the page is handed over with no exit fade or float-in. */
export const LOADER_LATE_AT_MS = HOME_LOADER_MAX_MS - MIN_HOLD_MS;

/** The loader's latest exit, in ms from `nowMs` (ms after navigation start). */
export function loaderMaxMs(nowMs: number): number {
  return Math.max(MIN_HOLD_MS, HOME_LOADER_MAX_MS - nowMs);
}

/**
 * The exit timings, in ms from the moment the page hydrates (`nowMs` after
 * navigation start), for a mark whose CSS reveal has been drawing for
 * `revealElapsedMs` (null when that clock cannot be read: the whole reveal is
 * still to come). The loader leaves once the reveal is over and the stage is
 * ready, and at the latest at the cap.
 */
export function loaderTimings(
  nowMs: number,
  revealElapsedMs: number | null,
): LoaderTimings {
  return {
    minMs: Math.max(0, REVEAL_MS - (revealElapsedMs ?? 0)),
    maxMs: loaderMaxMs(nowMs),
    exitMs: DEFAULT_TIMINGS.exitMs,
  };
}

/** The html attribute (`data-stage-loader`) the script sets. */
export const STAGE_LOADER_ATTR = 'data-stage-loader';
/** The loader shell's marker attribute (StageLoader). */
export const STAGE_LOADER_SHELL_ATTR = 'data-stage-loader-shell';

/**
 * The only paths the script acts on (it runs in the root layout's `<head>`, on
 * every page, and is inert everywhere else). Exact pathnames; a trailing slash
 * is ignored.
 */
export const STAGE_LOADER_PATHS: readonly string[] = ['/home-preview'];

/**
 * Covers the page from the very first paint until the loader shell itself is
 * parsed (the header comes before it in the body), then gets out of the way:
 * `:has()` drops it the moment the shell exists. Hides itself at 3.5 s like the
 * shell's own failsafe, so it can never stick.
 */
const PRE_COVER_CSS =
  `html[${STAGE_LOADER_ATTR}]:not(:has([${STAGE_LOADER_SHELL_ATTR}]))::before{` +
  `content:"";position:fixed;inset:0;z-index:1000;background:#0a0a0a;` +
  `animation:stage-precover-failsafe 0s linear 3.5s forwards}` +
  `@keyframes stage-precover-failsafe{to{visibility:hidden}}`;

/**
 * The script's source. On a path in `paths` only, it decides whether this
 * document load shows the brand loader; if so it sets `html[data-stage-loader]`
 * and adds the pre-cover style. The preview's
 * `?loader=never|always` is read here, from the URL, never on the server:
 * `always` (QA only) skips the device checks but still needs storage, like
 * every real load.
 */
export function stageLoaderScript(
  paths: readonly string[] = STAGE_LOADER_PATHS,
  crashKey: string = STAGE_CRASH_KEY,
): string {
  const crash = JSON.stringify(crashKey);
  return (
    `(function(){try{` +
    `var l=window.location,p=l.pathname.replace(/\\/+$/,'')||'/';` +
    `if(${JSON.stringify(paths)}.indexOf(p)<0)return;` +
    `var q=/[?&]loader=(always|never)(&|$)/.exec(l.search),f=q?q[1]:'';` +
    `if(f==='never')return;` +
    `var s=window.sessionStorage;` +
    `if(f!=='always'){` +
    `if(s.getItem(${crash})!==null)return;` +
    `var m=window.matchMedia;` +
    `if(m&&m('(prefers-reduced-motion: reduce)').matches)return;` +
    `if(m&&m('(prefers-reduced-data: reduce)').matches)return;` +
    `var n=navigator,c=n.connection;` +
    `if(c&&c.saveData)return;` +
    `if(typeof n.deviceMemory==='number'&&n.deviceMemory<=2)return;` +
    `}` +
    `var d=document,st=d.createElement('style');` +
    `st.textContent=${JSON.stringify(PRE_COVER_CSS)};` +
    `d.head.appendChild(st);` +
    `d.documentElement.setAttribute('${STAGE_LOADER_ATTR}','1');` +
    `}catch(e){}})();`
  );
}

/**
 * The pre-cover's failsafe on a load onto a pack's own address: a second
 * after ENTRY_LOADER_MAX_MS, not the usual 3.5 s.
 */
const ENTRY_PRE_COVER_CSS =
  `html[${FLOW_COVER_ATTR}][${STAGE_LOADER_ATTR}]:not(:has([${STAGE_LOADER_SHELL_ATTR}]))::before{` +
  `animation-delay:${ENTRY_LOADER_MAX_MS / 1000 + 1}s}`;

/**
 * The preview page's own inline script for a load onto pack `id`'s address,
 * written first in the page (before the loader shell), never in the layout's
 * head: reduced motion never gets the flow, so it takes today's pack page
 * (`packPage`) before the stage paints; a load the loader covers is marked
 * `html[data-flow-entry=<id>]`, so the cover stays until the pack is placed,
 * and its pre-cover failsafe waits as long.
 */
export function flowEntryScript(id: string, packPage: string): string {
  return (
    `(function(){var d=document.documentElement;` +
    `if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){window.location.replace(${JSON.stringify(packPage)});return}` +
    `try{if(!d.hasAttribute('${STAGE_LOADER_ATTR}'))return;` +
    `d.setAttribute('${FLOW_ENTRY_ATTR}',${JSON.stringify(id)});` +
    `d.setAttribute('${FLOW_COVER_ATTR}','');` +
    `var s=document.createElement('style');` +
    `s.textContent=${JSON.stringify(ENTRY_PRE_COVER_CSS)};` +
    `document.head.appendChild(s);` +
    `}catch(e){}})();`
  ).replace(/</g, '\\u003c');
}
