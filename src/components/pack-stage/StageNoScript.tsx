/**
 * The pack stage without JavaScript, as a server-rendered `<noscript>` style
 * (kept out of the client bundle: only the server renders it). The page that
 * renders `PackStage` renders this beside it.
 */
// Without JS: every category's panel shows (each with its name), and each
// carousel falls back to a swipeable snap row (phones) or a grid (desktop).
// The panel rule sits in Tailwind's base layer: preflight's `[hidden]` rule is
// `!important` there, and a layered !important beats any unlayered one.
export const NO_SCRIPT_CSS = `
@layer base{[data-stage-panel][hidden]{display:block!important}}
[data-stage-panel-name]{position:static!important;width:auto!important;height:auto!important;margin:2rem 0 .75rem!important;clip:auto!important;clip-path:none!important;overflow:visible!important;white-space:normal!important}
[data-stage-nav],[data-stage-info],[data-stage-count],[data-stage-chips]{display:none!important}
[data-stage-viewport]{height:auto!important;perspective:none!important;touch-action:auto!important;user-select:auto!important;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:1rem}
[data-stage-row]{position:static!important;transform:none!important;width:max-content;gap:1rem;padding:0 1rem}
[data-stage-tile]{width:auto!important;scroll-snap-align:center}
[data-stage-hit]{pointer-events:auto!important}
[data-stage-pose]{transform:none!important;opacity:1!important}
[data-stage-label]{transform:none!important;opacity:1!important}
[data-stage-art] img{filter:none!important}
[data-spin-wrap]{height:auto!important}
[data-stage-root]{position:relative!important;top:auto!important;height:auto!important}
[data-spin-after]{margin-top:0!important}
@media (min-width:1024px){[data-stage-viewport]{overflow:visible}[data-stage-row]{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));width:auto}[data-stage-art]{width:10.75rem!important;height:20rem!important}}
`;

/** Place once on the page, next to `PackStage`. */
export function StageNoScript() {
  return (
    <noscript>
      <style dangerouslySetInnerHTML={{ __html: NO_SCRIPT_CSS }} />
    </noscript>
  );
}
