/**
 * Gera .vercel/output (Build Output API v3): estáticos + 1 função Node com a API inteira empacotada.
 * Assim o que roda na Vercel é exatamente o que dá para testar localmente (npm run test:vercel).
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const OUT = ".vercel/output";
rmSync(OUT, { recursive: true, force: true });
execSync("npm run build:web", { stdio: "inherit" });

mkdirSync(`${OUT}/static`, { recursive: true });
cpSync("public", `${OUT}/static`, { recursive: true });

const fn = `${OUT}/functions/api.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ["src/vercel.ts"], outfile: `${fn}/index.mjs`, bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["pg-native"], minify: false, sourcemap: false, legalComments: "none",
  // pg é CommonJS: dá um require() de verdade dentro do bundle ESM.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 15 }, null, 2));
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: "module" }));

writeFileSync(`${OUT}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: "^/api/(.*)$", dest: "/api" },
    { handle: "filesystem" },
  ],
  crons: [{ path: "/api/v1/cron/recurrences", schedule: "17 9 * * *" }],
}, null, 2));
console.log("Vercel build output pronto em .vercel/output");
