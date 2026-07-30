# scripts/

One-off Playwright capture/measure/QA scripts and operational utilities. Nothing
here is imported by the app or built — these are run by hand, usually against
the production standalone build on `:4000` (see the root `CLAUDE.md` for why
`next dev` is not a valid verification target).

Two entries are wired into `package.json` and must keep working:
`qa-csp.mjs` (`npm run qa:csp`) and `qa-a11y.mjs` (`npm run test:a11y`), both
driving the route list in `qa-routes.mjs`. `serve-standalone.ps1` is the server
the README's Quick Start uses.

## The art-pipeline family needs its input tree restored

59 scripts here read `public/images/claw/*` — the claw-machine renders and pack
icons (brand-zone baking, placard measurement, banner crops, AVIF probes). **That
directory was deleted in #304** after verification that nothing referenced it: no
`src/` import, no DB row, and no image URL on any rendered prod page.

The scripts were kept on purpose. They encode technique, not just paths, and
re-point at a different asset directory by editing one constant (`DIR`, or the
`public/images/claw/${base}-machine.webp` template). Most fail loudly if you
forget — 31 throw `ENOENT` naming the missing file — but a handful enumerate the
directory instead and will quietly do nothing.

To run one against the original art:

```bash
git show ca43766b:public/images/claw/<file> > /tmp/<file>
```

or restore the whole tree into a scratch dir and point the script's `DIR` at it.
Current pack art lives in `public/images/polycards/` and on the Spaces CDN.
