# scripts/

One-off Playwright capture/measure/QA scripts and operational utilities. Nothing
here is imported by the app or built — these are run by hand, usually against
the production standalone build on `:4000` (see the root `CLAUDE.md` for why
`next dev` is not a valid verification target).

Two entries are wired into `package.json` and must keep working:
`qa-csp.mjs` (`npm run qa:csp`) and `qa-a11y.mjs` (`npm run test:a11y`), both
driving the route list in `qa-routes.mjs`. `serve-standalone.ps1` is the server
the root `README.md`'s Quick Start invokes:

```bash
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000
```

## Adding a script here

One-off debug/capture scripts are born in the gitignored scratchpad
(`docs/research/`) or a PR branch — not committed straight to master's
`scripts/`. A script belongs here only once something references it —
`package.json`, `.github/workflows/*`, `docs/**`, `tests/**`, or
`README.md` — **or** this README states its trigger/purpose (as the
art-pipeline family below does). That KEEP rule wins over any other signal
at triage time: a referenced script stays even once its target route has
gone stale (fixing that is a separate task).

## The art-pipeline family needs its input tree restored

59 scripts here reference `public/images/claw/*` — the claw-machine renders and
pack icons (brand-zone baking, placard measurement, banner crops, AVIF probes).
**That directory was deleted in #304**, after verifying that no _runtime_ surface
depended on it: no `src/` import, no DB row, and no image URL on any rendered
prod page. These scripts were the only remaining references, and they don't ship.

They were kept on purpose: they encode technique, not just paths, and re-point at
a different asset directory by editing one constant (`DIR`, or the
`public/images/claw/${base}-machine.webp` template). How they behave now, if you
run one without restoring the tree:

| Consumption pattern                            | Count | Behaviour                                     |
| ---------------------------------------------- | ----- | --------------------------------------------- |
| Reads specific files                           | 31    | exits 1 with `ENOENT` naming the missing path |
| Enumerates the directory                       | 4     | quietly does nothing                          |
| Only mentions the path (comment, URL template) | 24    | unaffected                                    |

To run one against the original art:

```bash
git show ca43766b:public/images/claw/<file> > /tmp/<file>
```

or restore the whole tree into a scratch dir and point the script's `DIR` at it.
Current pack art lives in `public/images/polycards/` and on the Spaces CDN.
