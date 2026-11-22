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
    // Cabeçalhos de segurança também nas páginas estáticas (a API já recebe os seus no Hono).
    { src: "^/(?!api/).*", headers: {
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
      "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY",
      "strict-transport-security": "max-age=31536000; includeSubDomains", "permissions-policy": "camera=(self), microphone=(), geolocation=()" }, continue: true },
    // O service worker precisa ser revalidado sempre, senão uma versão velha fica presa no celular.
    { src: "^/(sw\\.js|manifest\\.json)$", headers: { "cache-control": "no-cache" }, continue: true },
    { handle: "filesystem" },
  ],
  crons: [{ path: "/api/v1/cron/recurrences", schedule: "17 9 * * *" }],
}, null, 2));
console.log("Vercel build output pronto em .vercel/output");
