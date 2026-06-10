---
name: nextjs-turbopack
description: Next.js 16+ and Turbopack — incremental bundling, FS caching, dev speed, and when to use Turbopack vs webpack.
---

# Next.js and Turbopack

Next.js 16+ uses Turbopack as the **stable default for both `next dev` and `next build`**: an incremental bundler written in Rust that significantly speeds up dev startup, hot updates, and production builds (2–5x faster prod builds).

## When to Use

- **Turbopack (default)**: The stable default for both `next dev` and `next build`. Faster cold start and HMR, plus 2–5x faster production builds, especially in large apps.
- **Webpack (legacy opt-out)**: Use only if you hit a Turbopack bug or rely on a webpack-only plugin. Opt out with the documented **`--webpack`** flag (on `next dev` and/or `next build`).
- **Production**: `next build` runs on Turbopack by default in Next.js 16. Next.js 16.1 added **stable filesystem caching** for builds.

Use when: developing or debugging Next.js 16+ apps, diagnosing slow dev startup or HMR, or optimizing production bundles.

## How It Works

- **Turbopack**: Incremental bundler for Next.js dev. Uses file-system caching so restarts are much faster (e.g. 5–14x on large projects).
- **Default everywhere**: From Next.js 16, both `next dev` and `next build` run with Turbopack unless you pass `--webpack`.
- **File-system caching**: Restarts reuse previous work; cache is typically under `.next`; no extra config needed for basic use. Next.js 16.1 made filesystem caching **stable for production builds** too.
- **Bundle Analyzer (Next.js 16.1+)**: Experimental Bundle Analyzer to inspect output and find heavy dependencies; enable via config or experimental flag (see Next.js docs for your version).

## Examples

### Commands

```bash
next dev
next build
next start
```

### Usage

Run `next dev` for local development with Turbopack. Use the Bundle Analyzer (see Next.js docs) to optimize code-splitting and trim large dependencies. Prefer App Router and server components where possible.

## Best Practices

- Stay on a recent Next.js 16.x for stable Turbopack and caching behavior.
- If dev is slow, ensure you're on Turbopack (default) and that the cache isn't being cleared unnecessarily.
- For production bundle size issues, use the official Next.js bundle analysis tooling for your version.
