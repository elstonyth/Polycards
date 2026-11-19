/**
 * The stage's pre-paint loader gate (plan section 6), as the source of a tiny
 * inline `<script>` the root layout emits in `<head>` (before anything paints;
 * inert on every path but STAGE_LOADER_PATHS). It decides whether this
 * document load shows the brand loader: if so it marks the session and sets
 * `html[data-stage-loader]`, which is the only thing that makes the loader
 * shell visible (pack-stage.module.css).
 *
 * The loader shows only when ALL hold: the session has not seen it
 * (`BRAND_LOADER_SESSION_KEY`), the cheap gate predicts 3D (no reduced motion,
 * no save-data, no crash flag, not `deviceMemory <= 2`), and storage is
 * readable. Any throw skips the loader: a pre-hydration overlay must never risk
 * sticking (the opposite default of `claimFirstVisitThisSession`).
 *
 * Server-safe: builds a string, runs nothing.
 */
import { BRAND_LOADER_SESSION_KEY } from '@/components/loader/first-visit';
import { STAGE_CRASH_KEY } from './crash-guard';

/** Owner decision 6 (plan section 11): the loader's hold cap, in ms from
 *  NAVIGATION start (not from hydration). */
export const HOME_LOADER_MAX_MS = 3000;
/** Never cut the loader's exit shorter than this after it mounts. */
const MIN_HOLD_MS = 800;

/** A loader that would only get going after this (ms from navigation start)
 *  is skipped: the page is handed over at once, with no reveal or float-in. */
export const LOADER_LATE_AT_MS = HOME_LOADER_MAX_MS - MIN_HOLD_MS;

/** BrandLoader's `maxMs` for a loader mounting `nowMs` after navigation start. */
export function loaderMaxMs(nowMs: number): number {
  return Math.max(MIN_HOLD_MS, HOME_LOADER_MAX_MS - nowMs);
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
 * document load shows the brand loader; if so it marks the session, sets
 * `html[data-stage-loader]` and adds the pre-cover style. The preview's
 * `?loader=never|always` is read here, from the URL, never on the server:
 * `always` (QA only) skips the seen-this-session and device checks but still
 * needs storage, like every real first visit.
 */
export function stageLoaderScript(
  paths: readonly string[] = STAGE_LOADER_PATHS,
  keys: { session: string; crash: string } = {
    session: BRAND_LOADER_SESSION_KEY,
    crash: STAGE_CRASH_KEY,
  },
): string {
  const session = JSON.stringify(keys.session);
  const crash = JSON.stringify(keys.crash);
  return (
    `(function(){try{` +
    `var l=window.location,p=l.pathname.replace(/\\/+$/,'')||'/';` +
    `if(${JSON.stringify(paths)}.indexOf(p)<0)return;` +
    `var q=/[?&]loader=(always|never)(&|$)/.exec(l.search),f=q?q[1]:'';` +
    `if(f==='never')return;` +
    `var s=window.sessionStorage;` +
    `if(f!=='always'){` +
    `if(s.getItem(${session})==='1')return;` +
    `if(s.getItem(${crash})!==null)return;` +
    `var m=window.matchMedia;` +
    `if(m&&m('(prefers-reduced-motion: reduce)').matches)return;` +
    `if(m&&m('(prefers-reduced-data: reduce)').matches)return;` +
    `var n=navigator,c=n.connection;` +
    `if(c&&c.saveData)return;` +
    `if(typeof n.deviceMemory==='number'&&n.deviceMemory<=2)return;` +
    `}` +
    `s.setItem(${session},'1');` +
    `var d=document,st=d.createElement('style');` +
    `st.textContent=${JSON.stringify(PRE_COVER_CSS)};` +
    `d.head.appendChild(st);` +
    `d.documentElement.setAttribute('${STAGE_LOADER_ATTR}','1');` +
    `}catch(e){}})();`
  );
}
