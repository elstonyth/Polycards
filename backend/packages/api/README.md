<p align="center">
  <a href="https://www.medusajs.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/59018053/229103275-b5e482bb-4601-46e6-8142-244f531cebdb.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    <img alt="Medusa logo" src="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    </picture>
  </a>
</p>
<h1 align="center">
  Medusa
</h1>

<h4 align="center">
  <a href="https://docs.medusajs.com">Documentation</a> |
  <a href="https://www.medusajs.com">Website</a>
</h4>

<p align="center">
  Building blocks for digital commerce
</p>
<p align="center">
  <a href="https://github.com/medusajs/medusa/blob/master/CONTRIBUTING.md">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" alt="PRs welcome!" />
  </a>
    <a href="https://www.producthunt.com/posts/medusa"><img src="https://img.shields.io/badge/Product%20Hunt-%231%20Product%20of%20the%20Day-%23DA552E" alt="Product Hunt"></a>
  <a href="https://discord.gg/xpCwq3Kfn8">
    <img src="https://img.shields.io/badge/chat-on%20discord-7289DA.svg" alt="Discord Chat" />
  </a>
  <a href="https://twitter.com/intent/follow?screen_name=medusajs">
    <img src="https://img.shields.io/twitter/follow/medusajs.svg?label=Follow%20@medusajs" alt="Follow @medusajs" />
  </a>
</p>

## Compatibility

This starter is compatible with versions >= 2 of `@medusajs/medusa`. 

## Getting Started

Visit the [Quickstart Guide](https://docs.medusajs.com/learn/installation) to set up a server.

Visit the [Docs](https://docs.medusajs.com/learn/installation#get-started) to learn more about our system requirements.

## Running the integration tests locally

The money-path guarantees live in the HTTP integration suites
(`integration-tests/http/*.spec.ts`). CI runs all of them on every backend
change (`.github/workflows/ci.yml`, `integration-http` job); this section is
the local equivalent.

### Prerequisites

- **Postgres + Redis** — the shared local containers `pokenic-postgres`
  (Postgres 16) and `pokenic-redis` (Redis 7) must be running:
  `docker start pokenic-postgres pokenic-redis`. First time on a machine,
  create them per the root `README.md` ("Running the backend") — e.g.
  `pwsh scripts/launch-stack.ps1`.
- **Install + build workspace deps** — from `backend/`:
  `corepack yarn install --immutable && corepack yarn build --filter="@acme/api^..."`.
  Jest resolves workspace deps such as `@acme/odds-math` via their `dist/`
  entrypoints, which don't exist on a fresh install.

### Environment

`jest.config.js` calls `loadEnv('test', …)`, which loads the tracked test env
file in this directory. It already pins everything the Medusa test runner
needs to the local containers — `DATABASE_URL` plus `DB_HOST` / `DB_PORT` /
`DB_USERNAME` / `DB_PASSWORD` (used by `@medusajs/test-utils` `initDb`) — so
no manual env setup is needed locally. `REDIS_URL` is optional and defaults
to `redis://localhost:6379`. dotenv never overrides pre-set env, so CI runs
the same suites against its service containers simply by exporting those
names (see the `integration-http` job). The suites mint their own super-admin
(`integration-tests/http/utils.ts`) — no seeded credentials required.

### Commands

From `backend/packages/api`:

| Command                                              | What it runs                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack yarn test:integration:smoke`                | Money-loop smoke (5 suites, ~5–7 min): economy report, credit top-up, pack-open charge, vault buyback, commission maturity              |
| `corepack yarn test:integration:http economy.spec`    | Filtered subset — one or more jest path patterns, single non-sharded process                                                          |
| `corepack yarn test:integration:http`                 | Full gate (all 66 suites) in 3 sequential shards                                                                                       |

The full run is sharded because every suite boots a complete Medusa app and a
single `--runInBand` process exhausts node's ~4 GB heap — see
[`integration-tests/run-http-shards.mjs`](integration-tests/run-http-shards.mjs).

The test runner creates and drops its own per-suite databases on the local
Postgres, so your dev database is never touched.

## What is Medusa

Medusa is a set of commerce modules and tools that allow you to build rich, reliable, and performant commerce applications without reinventing core commerce logic. The modules can be customized and used to build advanced ecommerce stores, marketplaces, or any product that needs foundational commerce primitives. All modules are open-source and freely available on npm.

Learn more about [Medusa’s architecture](https://docs.medusajs.com/learn/introduction/architecture) and [commerce modules](https://docs.medusajs.com/learn/fundamentals/modules/commerce-modules) in the Docs.

## Community & Contributions

The community and core team are available in [GitHub Discussions](https://github.com/medusajs/medusa/discussions), where you can ask for support, discuss roadmap, and share ideas.

Join our [Discord server](https://discord.com/invite/medusajs) to meet other community members.

## Other channels

- [GitHub Issues](https://github.com/medusajs/medusa/issues)
- [Twitter](https://twitter.com/medusajs)
- [LinkedIn](https://www.linkedin.com/company/medusajs)
- [Medusa Blog](https://medusajs.com/blog/)
