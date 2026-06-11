import { defineConfig } from "vitest/config";

// Storefront unit tests only (src/lib, src/hooks logic — see
// .claude/rules/common/testing.md). The backend workspace has its own jest
// suites under backend/, run via `corepack yarn test:unit` there — vitest's
// default glob would otherwise pick those .spec.ts files up and fail.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
