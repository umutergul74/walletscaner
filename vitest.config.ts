import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@memecoin-alpha/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@memecoin-alpha/config": new URL("./packages/config/src/index.ts", import.meta.url).pathname,
      "@memecoin-alpha/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@memecoin-alpha/providers": new URL("./packages/providers/src/index.ts", import.meta.url)
        .pathname,
      "@memecoin-alpha/scoring": new URL("./packages/scoring/src/index.ts", import.meta.url)
        .pathname,
      "@memecoin-alpha/backtesting": new URL("./packages/backtesting/src/index.ts", import.meta.url)
        .pathname,
      "@memecoin-alpha/paper-trading": new URL(
        "./packages/paper-trading/src/index.ts",
        import.meta.url
      ).pathname,
      "@memecoin-alpha/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"]
    }
  }
});
