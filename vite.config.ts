import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// A GitHub Pages project site is served from /<repo-name>/, not "/". The deploy
// workflow sets BASE_PATH accordingly; local dev and a custom domain leave it
// unset. src/lib/hts.ts reads the resulting import.meta.env.BASE_URL when it
// fetches the data files, so the snapshot resolves correctly under either root.
const base = process.env["BASE_PATH"] ?? "/";

export default defineConfig({
  base,
  plugins: [tailwindcss()],
  server: { port: 8084 },
  build: { target: "es2022", outDir: "dist", assetsDir: "assets" },
});
