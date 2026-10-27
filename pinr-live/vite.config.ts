import { defineConfig } from "vite";
import { artVersions } from "./artversions";

export default defineConfig({
  build: { target: "es2022", sourcemap: false },
  // Every /art/ address carries its file's content hash, so a changed picture or video reaches every visitor at once (artversions.ts).
  plugins: [artVersions("public")],
  // The feed server (npm run feed) is local and read-only. The page talks to it only through this pass-through, so a phone
  // on the Wi-Fi never reaches the server directly.
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "node", include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
});
