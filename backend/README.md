# NOFINANCE (PESSOAL)

Sistema completo: abra **http://localhost:3333** depois de `npm run dev`. O front (TypeScript + HTML + CSS, em `web/` e `public/`) é servido pela própria API.

API de controle financeiro: contas a pagar e a receber (previsto), baixas, receitas e despesas (realizado),
dívidas com juros, lançamentos automáticos mensais, projeção de longo prazo, simulador e guardião.

Stack: Node 22 · TypeScript · Hono · PostgreSQL 16 · Zod · Vitest.

## Rodar no localhost (Windows)
**Mais fácil:** clique duas vezes em `instalar.cmd` (uma vez só), depois em `iniciar.cmd`. Cópia de segurança: `backup.cmd`.

Pelo PowerShell:
Requisitos: Node 22+ e PostgreSQL instalados. Rode **um comando por vez**:
```
cd $HOME\Downloads\nofinance\backend
copy .env.example .env
notepad .env          # troque a senha do postgres nas linhas DATABASE_URL e TEST_DATABASE_URL
npm install
npm run migrate       # cria o banco e as tabelas (começa VAZIO)
npm test              # 35 testes
npm run dev           # API em http://localhost:3333/api/v1
```
Outros: `npm run backup` (cópia em backups/, mantém 30) · `npm run restore -- backups\arquivo.dump`.
Se o PowerShell disser que a execução de scripts está desabilitada: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Uso pessoal: nada é bloqueado
Regras viram **avisos gravados**: cartão para pagar dívida, pagamento acima do saldo, gasto fora do escopo do guardião.
Veja em `GET /api/v1/personal/warnings`. Toda alteração fica em `audit_log`; cada requisição gera uma linha de log no terminal.

## Conceito
| | Em aberto (previsto) | Realizado (caixa) |
|---|---|---|
| Saída | Conta a pagar (`PAYABLE`) | Despesa |
| Entrada | Conta a receber (`RECEIVABLE`) | Receita |

Natureza: `EXPENSE` conta · `DEBT` dívida · `CARD` fatura · `INCOME` receita · `LOAN_IN` empréstimo recebido.
- Empréstimo recebido **não é receita**: gera automaticamente a dívida em "a pagar".
- Pagar dívida: **juros = despesa**, o resto é amortização (não é despesa).
- Saldos, juros e totais são sempre **calculados**. Você edita os valores de entrada e o sistema recalcula.

## Endpoints (`/api/v1/{personal|byte4tech}`)
Dinheiro sempre em **centavos inteiros** (`amountCents: 345000` = R$ 3.450,00). Datas `AAAA-MM-DD`.

| Método | Rota | Uso |
|---|---|---|
| GET | `/dashboard` | A pagar, a receber, saldo previsto, dívidas, vencidas, sem valor, prioridade |
| GET/POST | `/titles` | Listar (`?kind=&status=open\|settled&from=&to=`) / criar conta |
| GET/PATCH/DELETE | `/titles/:id` | Ver com pagamentos / **editar** / excluir (lógico) |
| POST | `/titles/:id/settlements` | Pagar/receber. Header `Idempotency-Key` evita duplicar |
| PATCH/DELETE | `/settlements/:id` | **Editar** / excluir pagamento |
| GET/POST/PATCH | `/recurrences` | Lançamentos automáticos (aluguel, água, luz, internet, renda) |
| POST | `/recurrences/generate?month=AAAA-MM` | Gera o mês (idempotente; o servidor já faz sozinho) |
| GET | `/statement?from=AAAA-MM&to=AAAA-MM` | Receitas, despesas, juros, amortização, caixa por mês |
| GET | `/projection?months=36` | Projeção de até 120 meses (estimativa) |
| POST | `/simulate` | Em quanto tempo saio (avalanche × bola de neve) |
| POST | `/guard/check` · `/expenses/quick` | Posso gastar? · Já gastei (registra despesa paga, nunca bloqueia) |
| GET | `/warnings` | Log de avisos (o que passou fora da regra) |
| GET | `/export.csv` · `/audit/:id` | Exportação (Excel pt-BR) · histórico de alterações |

Erros: `{ "error": { "code", "message", "details" } }`. 400 dado inválido · 404 não encontrado · 422 dado incoerente (ex.: juros em conta que não é dívida).

## Lançamento automático
Recorrências geram a conta do mês atual e do próximo ao subir o servidor e a cada 6 h.
Valor variável (luz, água): a conta nasce **"a definir"**; o primeiro pagamento fixa o valor; o mês seguinte usa o último valor como estimativa.
Excluir a conta de um mês não faz o gerador recriá-la.

## Decisões (ADR resumido)
1. **Centavos em BIGINT**, arredondamento HALF_UP uma vez por cálculo. Nunca float.
2. **Hono** em vez de Fastify: roda igual no Node (localhost) e na Vercel (serverless).
3. **Edição livre, sem bloqueios, com auditoria e avisos**: o pedido foi editar e recalcular. Toda alteração grava antes/depois em `audit_log` (trigger no banco); exclusão física é proibida.
4. Juros: mês cheio sem pro-rata; dívida quita juros primeiro. A confirmar com os credores.
5. PERSONAL e BYTE4TECH isolados por rota + `entity_code` em toda consulta.

## Antes de publicar na Vercel (não fazer antes disso)
- [ ] `API_TOKEN` obrigatório (hoje opcional) ou login com 2FA. Os dados são pessoais e financeiros.
- [ ] Postgres gerenciado (Neon/Supabase) com TLS; backup do provedor + `npm run backup` periódico.
- [ ] Trocar o `setInterval` por **Vercel Cron** chamando `/recurrences/generate`.
- [ ] Rate limiting e CORS restrito ao domínio do front.
