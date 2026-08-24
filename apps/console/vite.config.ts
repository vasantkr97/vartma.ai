import { defineConfig } from "vite";

export default defineConfig({
  base: "/console/",
  build: {
    sourcemap: true,
    target: "es2022",
  },
});
