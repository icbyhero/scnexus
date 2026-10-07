import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PACKAGE_ROOT = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root: PACKAGE_ROOT,
  resolve: {
    alias: {
      "@/": join(PACKAGE_ROOT, "src") + "/",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
