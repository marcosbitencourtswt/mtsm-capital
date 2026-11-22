# MTSM Capital · Family Finance

Projeto independente: gestão financeira da família (contexto PESSOAL) com uma área PJ só para o administrador.
Não misturar com outros projetos/sessões (ECOS, Hermes, organizadores etc.).

## Regras do projeto
- **Custo zero**: nada que gere cobrança (sem OCR pago, Open Finance, WhatsApp oficial, APIs pagas). Se algo custar, fica fora do escopo.
- **Dados pessoais fora do Git** (o repositório é público): nomes reais, valores, documentos e o manual de uso ficam em `docs/` (ignorado). No código e nos testes, use nomes neutros.
- **Segredos nunca no código nem no chat**: chaves e conexões só nas variáveis da Vercel / Secrets do GitHub.
- Simples e usual: cada tela precisa ser entendida por quem não é técnico.
- Mês fecha sozinho no dia 5 do mês seguinte; só o root altera mês fechado.
- PJ (Byte4Tech): só recebe a nota, paga impostos/contador e repassa para a PF. O resto acontece no Pessoal.

## Arquitetura (pasta `backend/`, raiz do deploy na Vercel)
- Node 22 + TypeScript, Hono, PostgreSQL (Neon, plano grátis), zod, vitest.
- Front sem framework: `web/` (TypeScript, módulos em `web/pages/`) empacotado com esbuild em `public/app.js`. PWA (`public/sw.js`).
- Banco: `db/migrations/NNN_*.sql` (sempre nova migração, nunca editar uma aplicada). Dinheiro em centavos (BIGINT).
- Auditoria por gatilho (`audit_log`), exclusão lógica (`deleted_at`), escrita em transação com o usuário em `app.user_id`.
- Segurança: sessão em cookie, 2FA (TOTP), bloqueio por tentativas, CSP sem scripts inline, perfil "só combinados" com lista de rotas permitidas no servidor.
- Backup: GitHub Actions diário (precisa dos Secrets) + botão de cópia criptografada no app (root).

## Como trabalhar
- Testes: `cd backend && npx vitest run` (unitários + API) e `npm run test:e2e` (Playwright, tela).
  Precisam de PostgreSQL local em 127.0.0.1:5432 (bancos `nofinance_test`).
- Tipos: `npm run typecheck`.
- Antes de commitar: testes verdes e o diff sem dados pessoais.
- Deploy: push na `main` → Vercel publica e aplica as migrações (só produção).
