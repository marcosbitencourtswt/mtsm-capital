import { pathToFileURL } from "node:url";
/**
 * Dados de demonstração usados só pelos testes (credores fictícios).
 * Valores sem dado confirmado NÃO são inventados: ficam 0 ("a definir") ou com observação PENDENTE.
 * Uso: npm run seed  (recusa rodar se já houver contas, para não duplicar)
 */
import { createPool } from "../src/db.js";
import { createTitle, createRecurrence } from "../src/service.js";

try { process.loadEnvFile(".env"); } catch { /* ok */ }

export async function seed(url?: string) {
  const db = createPool(url);
  try {
    const n = (await db.query("SELECT count(*)::int AS n FROM title")).rows[0].n;
    if (n > 0) { console.log(`Já existem ${n} contas. Seed ignorado.`); return; }
    const E = "PERSONAL" as const, due = "2026-12-04", start = "2026-11-04";
    const debt = (who: string, reais: number, rateBp = 0) => createTitle(db, E, {
      kind: "PAYABLE", nature: "DEBT", counterparty: who, category: "DIVIDA", amountCents: reais * 100,
      interestModel: rateBp ? "FIXED_ONCE" : "NONE", rateBp, dueDate: due, startDate: start,
      notes: rateBp ? "15% 'só este mês'. HIPÓTESE: se rolar, vira por ciclo. Validar." : null,
    });
    await debt("Credor A", 1000); await debt("Credor B", 500); await debt("Credor C", 3000, 1500); await debt("Credor D", 4000);
    await debt("Credor E", 5000, 1500); await debt("Credor F", 200); await debt("Credor G", 1000); await debt("Credor H", 2000);

    await createTitle(db, E, { kind: "PAYABLE", nature: "CARD", counterparty: "Cartão Inter", category: "CARTAO", amountCents: 200000, notes: "CONFIRMAR se é o total; vencimento PENDENTE" });
    await createTitle(db, E, { kind: "PAYABLE", nature: "CARD", counterparty: "Cartão Cora", category: "CARTAO", amountCents: 17600, notes: "Vencimento PENDENTE" });
    await createTitle(db, E, { kind: "RECEIVABLE", nature: "INCOME", counterparty: "A receber (nota)", category: "RENDA", amountCents: 1128200, dueDate: "2026-11-30", notes: "CONFIRMAR data" });
    await createTitle(db, E, { kind: "RECEIVABLE", nature: "INCOME", counterparty: "Pix", category: "RENDA", amountCents: 100000, notes: "Origem e data PENDENTES" });

    // Lançamentos automáticos mensais. Valor varia: fica "a definir" e o 1º pagamento define; depois usa o último valor.
    for (const [d, cat] of [["Aluguel", "MORADIA"], ["Água", "AGUA"], ["Luz", "LUZ"], ["Internet", "INTERNET"]] as const)
      await createRecurrence(db, E, { kind: "PAYABLE", nature: "EXPENSE", description: d, category: cat, defaultAmountCents: null, dueDay: null, startMonth: "2026-12" });
    // Renda mensal informada: 15.599 (CONFIRMAR se é líquida e o dia).
    await createRecurrence(db, E, { kind: "RECEIVABLE", nature: "INCOME", description: "Renda mensal", category: "RENDA", defaultAmountCents: 1559900, dueDay: null, startMonth: "2026-12" });

    await db.query(`INSERT INTO setting (entity_code, key, value) VALUES
      ('PERSONAL','lock_until','"2026-12-04"'),
      ('PERSONAL','fixed_ceiling_cents','325000'),
      ('PERSONAL','fixed_categories','["MORADIA","AGUA","LUZ","INTERNET","FIXO"]')
      ON CONFLICT DO NOTHING`);
    console.log("Seed aplicado.");
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) seed().catch(e => { console.error(e); process.exit(1); });
