import { painel } from "./pages/painel.js";
import { adminPage, newUser, editUser, resetUser, downloadBackup } from "./pages/admin.js";
import { bancosPage, newAccount, editAccount, billDialog, editTransfer, transferDialog } from "./pages/bancos.js";
import { combinadosPage, infractionDialog, blameDialog, planDialog, closeDialog, settleDialog, editRule } from "./pages/combinados.js";
import { pedidosPage, type PReq } from "./pages/pedidos.js";
import { indicadoresPage } from "./pages/indicadores.js";
import { rankingPage, editCats } from "./pages/ranking.js";
import { titles, newTitle, editTitle, payTitle, showPays, editPay } from "./pages/titles.js";
import { pessoas, newPerson, editPerson } from "./pages/pessoas.js";
import { extrato } from "./pages/extrato.js";
import { futuro, runSim } from "./pages/futuro.js";
import { submitExpense, runJuros } from "./pages/lancar.js";
import { config, newRec, editRec } from "./pages/config.js";
import { $, st, loadPeople, view, openDialog, str, dlg, toast, dlgForm, isAdmin, fail, centsOf } from "./core.js";
import { resetCharts, paintCharts, wireTooltips } from "./charts.js";
import { esc, today, addMonths, br, parseMoney } from "./fmt.js";
import { ApiError, getEntity, setEntity, root, type Me, type Kind, api } from "./api.js";
import qrcode from "qrcode-generator";
import { pushOn, pushOff } from "./pages/push.js";
import { sendReceipt } from "./pages/cupons.js";
import { importStatement } from "./pages/ofx.js";
import { importFile } from "./pages/importar.js";
import { type Budget, SPEND_CATS } from "./pages/orcamento.js";

/* ===================== Roteamento ===================== */
export type Tab = "painel" | "admin" | "bancos" | "combinados" | "pedidos" | "indicadores" | "ranking" | "pagar" | "receber" | "pessoas" | "extrato" | "futuro" | "config";
export const renderers: Record<Tab, () => Promise<string>> = { painel, admin: adminPage, bancos: bancosPage, combinados: combinadosPage, pedidos: pedidosPage, indicadores: indicadoresPage, ranking: rankingPage, pagar: () => titles("PAYABLE"), receber: () => titles("RECEIVABLE"), pessoas, extrato, futuro, config };
export const TITLES: Record<Tab, string> = { painel: "Painel", admin: "Administração", bancos: "Bancos e dívidas", combinados: "Combinados", pedidos: "Pedidos de compra", indicadores: "Indicadores", ranking: "Ranking da semana", pagar: "Contas a pagar", receber: "Contas a receber", pessoas: "Pessoas da casa", extrato: "Extrato", futuro: "Futuro", config: "Ajustes" };
export const side = $("#side"), scrim = $("#scrim");
export const menu = (open: boolean) => { side.classList.toggle("open", open); scrim.classList.toggle("open", open); };
$("#menu-btn").addEventListener("click", () => menu(true));
scrim.addEventListener("click", () => menu(false));

export async function render() {
  if (st.me?.conductOnly && st.tab !== "combinados" && st.tab !== "pedidos") st.tab = "combinados";
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === st.tab));
  if (moreBox.querySelector(`[data-tab="${st.tab}"]`)) setMore(true);
  $("#page-title").textContent = TITLES[st.tab]; document.title = `${TITLES[st.tab]} · NOFINANCE`;
  try { await loadPeople(); resetCharts(); view.innerHTML = await renderers[st.tab](); paintCharts(view); }
  catch (e) { view.innerHTML = `<div class="alert danger">${esc(e instanceof ApiError ? e.message : "Sem conexão com a API. Confira se o npm run dev está rodando.")}</div>`; }
}
/** "Mais": telas menos usadas ficam recolhidas; abrem sozinhas se a tela atual estiver lá. */
export const moreBtn = $<HTMLButtonElement>("#more-btn"), moreBox = $("#more-tabs");
wireTooltips(view);
export const setMore = (open: boolean) => { moreBox.hidden = !open; moreBtn.setAttribute("aria-expanded", String(open)); moreBtn.classList.toggle("open", open); };
moreBtn.addEventListener("click", () => setMore(moreBox.hidden));
$("#tabs").addEventListener("click", e => {
  const t = (e.target as HTMLElement).dataset.tab as Tab | undefined;
  if (t) { st.tab = t; menu(false); history.pushState(null, "", `#${t}`); scrollTo(0, 0); render(); }
});
export const entSel = $<HTMLSelectElement>("#entity");
entSel.value = getEntity();
entSel.addEventListener("change", () => { setEntity(entSel.value); st.personFilter = ""; st.personFilterSet = false; render(); });

/* ===================== Verificação em duas etapas ===================== */
export async function mfaSetup() {
  const s = await root<{ secret: string; uri: string }>("/auth/2fa/setup", { method: "POST" });
  const qr = qrcode(0, "M"); qr.addData(s.uri); qr.make();
  openDialog("Ativar verificação em duas etapas", `
    <ol class="full muted" style="margin:0;padding-left:18px">
      <li>Instale o <b>Google Authenticator</b> ou o <b>Microsoft Authenticator</b> no celular.</li>
      <li>No app, toque em <b>+</b> e leia o QR abaixo. Se estiver no próprio celular, escolha "inserir chave" e copie a chave.</li>
      <li>Digite os 6 números que aparecerem.</li></ol>
    <div class="full" style="text-align:center;background:#fff;padding:12px;border-radius:12px"><img alt="QR para o app autenticador" src="${qr.createDataURL(5, 2)}" width="220" height="220" style="image-rendering:pixelated"></div>
    <div class="full"><label>Chave (se não der para ler o QR)</label><input readonly value="${esc(s.secret.replace(/(.{4})/g, "$1 ").trim())}" style="font-family:monospace"></div>
    <div class="full"><label>Código de 6 números</label><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>`, "Ativar", async f => {
    const r = await root<{ recoveryCodes: string[] }>("/auth/2fa/enable", { method: "POST", body: { code: str(f, "code") } });
    st.me = await root<Me>("/auth/me"); dlg.close();
    openDialog("Guarde os códigos de recuperação", `
      <p class="full">Cada código entra <b>uma vez</b> se você perder o celular. Tire um print ou anote e guarde fora do celular. Eles não aparecem de novo.</p>
      <pre class="full" style="font-size:1.05rem;line-height:1.8;margin:0">${r.recoveryCodes.map(esc).join("\n")}</pre>`, "Já guardei", async () => { toast("Verificação em duas etapas ativada."); });
    dlgForm.querySelector<HTMLButtonElement>("[data-close]")!.hidden = true;
    return false;
  });
}
export function mfaDisable() {
  openDialog("Desativar verificação em duas etapas", `<p class="muted full">Sua conta volta a pedir só a senha.</p>
    <div class="full"><label>Sua senha</label><input name="pw" type="password" autocomplete="current-password" required></div>`, "Desativar", async f => {
    await root("/auth/2fa/disable", { method: "POST", body: { password: String(f.get("pw") ?? "") } });
    st.me = await root<Me>("/auth/me"); toast("Verificação em duas etapas desativada.");
  });
}
export function changePassword(forced: boolean) {
  openDialog(forced ? "Crie sua senha" : "Trocar senha", `${forced ? `<p class="muted full">Primeiro acesso: troque a senha provisória por uma só sua.</p>` : ""}
    <div class="full"><label>Senha atual</label><input name="cur" type="password" autocomplete="current-password" required></div>
    <div class="full"><label>Nova senha (mín. 10 caracteres)</label><input name="nxt" type="password" autocomplete="new-password" minlength="10" required></div>
    <div class="full"><label>Repita a nova senha</label><input name="nxt2" type="password" autocomplete="new-password" required></div>`, "Salvar", async f => {
    if (str(f, "nxt") !== str(f, "nxt2")) throw new ApiError(400, "MISMATCH", "As senhas novas não conferem.");
    await root("/auth/password", { method: "POST", body: { current: str(f, "cur"), next: str(f, "nxt") } });
    if (st.me) st.me.mustChangePassword = false;
    toast("Senha alterada. Os outros aparelhos foram desconectados.");
  });
  if (forced) dlgForm.querySelector<HTMLElement>("[data-close]")!.hidden = true;
}
export function renderMe() {
  $("#me").innerHTML = st.me ? `<div><b>${esc(st.me.name)}</b>${st.me.nickname ? ` <small>· ${esc(st.me.nickname)}</small>` : ""}<br><small>${st.me.isRoot ? "Root" : st.me.role === "ADMIN" ? "Administrador" : st.me.isGuardian ? "Responsável" : "Membro"}</small></div>
    <div class="row"><button data-act="password">Trocar senha</button><button data-act="logout">Sair</button></div>` : "";
  entSel.hidden = !isAdmin();
  $("#tab-admin").hidden = !isAdmin();
  const conly = !!st.me?.conductOnly;
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach(b => { if (b.id !== "tab-admin") b.hidden = conly && b.dataset.tab !== "combinados" && b.dataset.tab !== "pedidos"; });
  moreBtn.hidden = conly;
  if (conly && st.tab !== "pedidos") { st.tab = "combinados"; if (location.hash !== "#combinados") history.replaceState(null, "", "#combinados"); }
  if (!isAdmin() && st.tab === "admin") st.tab = "painel";
  if (!isAdmin() && getEntity() !== "personal") { setEntity("personal"); entSel.value = "personal"; }
}
export function showLogin() {
  st.me = null; document.documentElement.dataset.auth = "out"; dlg.close(); $("#mfa-form").hidden = true;
  root<{ needed: boolean }>("/auth/setup").then(r => {
    $("#setup-form").hidden = !r.needed; $("#login-form").hidden = r.needed;
    $<HTMLInputElement>(r.needed ? "#st-token" : "#lg-email").focus();
  }).catch(e => {
    // Banco desconectado ou servidor fora do ar: diz o motivo em vez de mostrar um login que não vai funcionar.
    $("#login-err").textContent = e instanceof ApiError ? e.message : "Servidor indisponível. Tente de novo em instantes.";
    $<HTMLInputElement>("#lg-email").focus();
  });
}
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement, f = new FormData(form), err = $("#setup-err"), btn = form.querySelector("button")!;
  err.textContent = "";
  if (String(f.get("password")) !== String(f.get("password2"))) { err.textContent = "As senhas não conferem."; return; }
  btn.disabled = true;
  try {
    const u = await root<Me>("/auth/setup", { method: "POST", body: { token: String(f.get("token")), name: str(f, "name"), email: str(f, "email"), password: String(f.get("password")) } });
    form.reset(); $("#setup-form").hidden = true; $("#login-form").hidden = false; await enter(u);
    toast("Sistema instalado. Cadastre as pessoas da casa e os usuários.");
  } catch (x) { err.textContent = x instanceof ApiError ? x.message : "Sem conexão com o servidor."; }
  finally { btn.disabled = false; }
});
export async function enter(user: Me) {
  st.me = user; document.documentElement.dataset.auth = "in";
  renderMe(); await render();
  if (st.me.mustChangePassword) changePassword(true);
}
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target as HTMLFormElement), err = $("#login-err"), btn = (e.target as HTMLFormElement).querySelector("button")!;
  err.textContent = ""; btn.disabled = true;
  try {
    const r = await root<Me & { mfaRequired?: boolean; challenge?: string }>("/auth/login", { method: "POST", body: { email: str(f, "email"), password: String(f.get("password") ?? "") } });
    (e.target as HTMLFormElement).reset();
    if (r.mfaRequired) { st.mfaChallenge = r.challenge!; $("#login-form").hidden = true; $("#mfa-form").hidden = false; $("#mfa-err").textContent = ""; $<HTMLInputElement>("#mfa-code").focus(); }
    else await enter(r);
  }
  catch (x) { err.textContent = x instanceof ApiError ? x.message : "Sem conexão com o servidor."; }
  finally { btn.disabled = false; }
});
$("#mfa-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement, err = $("#mfa-err"), btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  err.textContent = ""; btn.disabled = true;
  try {
    const u = await root<Me>("/auth/login/mfa", { method: "POST", body: { challenge: st.mfaChallenge, code: str(new FormData(form), "code") } });
    form.reset(); st.mfaChallenge = ""; $("#mfa-form").hidden = true; $("#login-form").hidden = false; await enter(u);
  } catch (x) {
    err.textContent = x instanceof ApiError ? x.message : "Sem conexão com o servidor.";
    if (x instanceof ApiError && x.code === "MFA_EXPIRED") setTimeout(() => { $("#mfa-form").hidden = true; $("#login-form").hidden = false; }, 2500);
  } finally { btn.disabled = false; }
});
$("#mfa-back").addEventListener("click", () => { st.mfaChallenge = ""; $("#mfa-form").hidden = true; $("#login-form").hidden = false; });
$("#me").addEventListener("click", async e => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (a === "password") changePassword(false);
  if (a === "logout") { await root("/auth/logout", { method: "POST" }).catch(() => {}); showLogin(); }
});
window.addEventListener("nf:unauthenticated", showLogin);
// Botão "voltar" do celular e links com #: troca de tela pelo endereço.
window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1) as Tab;
  if (t in renderers && t !== st.tab && st.me) { st.tab = t; menu(false); scrollTo(0, 0); render(); }
});

/* ===================== Eventos (delegação) ===================== */
view.addEventListener("click", async e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.new) await newTitle(d.new as Kind);
    else if (d.edit) await editTitle(d.edit);
    else if (d.pay) await payTitle(d.pay);
    else if (d.pays) await showPays(d.pays);
    else if (d.pedit) editPay(d.pedit, Number(d.amt), d.dt!);
    else if (d.pdel) { if (confirm("Excluir este pagamento? O saldo volta a ficar em aberto.")) { await api(`/settlements/${d.pdel}`, { method: "DELETE" }); toast("Pagamento excluído."); await render(); } }
    else if (d.del) { if (confirm("Excluir esta conta? Ela some das listas (fica no histórico).")) { await api(`/titles/${d.del}`, { method: "DELETE" }); toast("Conta excluída."); await render(); } }
    else if ("pf" in d) { st.personFilter = d.pf ?? ""; st.personFilterSet = true; await render(); }
    else if (d.filter) { st.statusFilter = d.filter as typeof st.statusFilter; await render(); }
    else if (d.proj) { st.projMonths = Number(d.proj); await render(); }
    else if (d.extyear) { if (d.extyear === "last6") { st.extTo = today().slice(0, 7); st.extFrom = addMonths(st.extTo, -5).slice(0, 7); } else { st.extFrom = `${d.extyear}-01`; st.extTo = `${d.extyear}-12`; } await render(); }
    else if (d.newrec !== undefined) newRec();
    else if (d.newperson !== undefined) newPerson();
    else if (d.goto) { if (d.bkowner !== undefined) st.bkOwner = d.bkowner; st.tab = d.goto as Tab; history.pushState(null, "", `#${st.tab}`); scrollTo(0, 0); await render(); }
    else if (d.reqok || d.reqno) {
      const id = (d.reqok ?? d.reqno)!, acc = (document.getElementById(`racc-${id}`) as HTMLSelectElement | null)?.value || null;
      const note = (document.getElementById(`rnote-${id}`) as HTMLInputElement | null)?.value.trim() || null;
      if (d.reqno && !note) { toast("Escreva o motivo no recado (ex.: sem saldo no Nubank, peça pelo Inter).", true); return; }
      if (d.reqok && !acc) { toast("Escolha de onde sai o dinheiro.", true); return; }
      await api(`/requests/${id}/review`, { method: "POST", body: { approve: !!d.reqok, accountId: acc, note } });
      toast(d.reqok ? "Aprovado e lançado." : "Recusado. A pessoa recebe o recado."); await render();
    }
    else if (d.print !== undefined) window.print();
    else if (d.rcdel) { if (confirm("Descartar este cupom? Ele não será lido.")) { await api(`/receipts/${d.rcdel}/discard`, { method: "POST" }); toast("Cupom descartado."); await render(); } }
    else if (d.backup !== undefined) downloadBackup();
    else if (d.toknew !== undefined) {
      const t = await root<{ token: string; expiresAt: string }>("/admin/worker-tokens", { method: "POST", body: { label: "Leitor de cupons (Claude)", days: 90 } });
      openDialog("Chave criada — aparece só agora", `<p class="full">Quando o Claude pedir, cole esta chave no <b>formulário seguro</b> que aparece na conversa (nunca no chat). Ela vence em ${br(t.expiresAt.slice(0, 10))}.</p>
        <div class="full"><input readonly value="${esc(t.token)}" style="font-family:monospace"></div>
        <p class="muted full">Perdeu? Revogue e crie outra.</p>`, "Fechei, já guardei", async () => {});
    }
    else if (d.tokrevoke) { if (confirm("Revogar esta chave? O leitor de cupons para de funcionar até você criar outra.")) { await root(`/admin/worker-tokens/${d.tokrevoke}`, { method: "DELETE" }); toast("Chave revogada."); await render(); } }
    else if (d.reqcancel) { await api(`/requests/${d.reqcancel}/cancel`, { method: "POST" }); toast("Pedido cancelado."); await render(); }
    else if (d.reqagain) { const r = (await api<PReq[]>("/requests")).find(x => x.id === d.reqagain); if (r) st.reqPrefill = { d: r.description, v: r.amountCents, c: r.category }; await render(); scrollTo(0, 0); }
    else if (d.review) { await api("/conduct/checks/review", { method: "POST", body: { personId: d.person, ruleId: d.review, day: d.day, approve: d.val === "true" } }); toast(d.val === "true" ? "Aprovado." : "Recusado: não conta na nota."); await render(); }
    else if (d.reviewall !== undefined) { for (const p of st.pendingCache) await api("/conduct/checks/review", { method: "POST", body: { personId: p.personId, ruleId: p.ruleId, day: p.day, approve: true } }); toast(`${st.pendingCache.length} aprovados.`); await render(); }
    else if (d.check) { await api("/conduct/checks", { method: "POST", body: { personId: d.person, ruleId: d.check, day: d.day, checked: d.val === "true" } }); await render(); }
    else if (d.cbweek !== undefined) { const n = Number(d.cbweek); if (n === 0) st.cbDate = today(); else { const x = new Date(`${st.cbDate}T12:00:00`); x.setDate(x.getDate() + n); st.cbDate = x.toLocaleDateString("sv-SE"); } await render(); }
    else if (d.infraction !== undefined) await infractionDialog();
    else if (d.newacc !== undefined) newAccount();
    else if (d.editacc) await editAccount(d.editacc);
    else if (d.bill) billDialog(d.bill);
    else if (d.edittr) await editTransfer(d.edittr);
    else if (d.deltr) { if (confirm("Excluir esta transferência? Os saldos das duas contas voltam ao que eram. Fica no registro de alterações.")) { await api(`/transfers/${d.deltr}`, { method: "DELETE" }); toast("Transferência excluída."); await render(); } }
    else if (d.transfer) await transferDialog(d.transfer);
    else if (d.bkowner !== undefined) { st.bkOwner = d.bkowner; await render(); }
    else if (d.strategy) { st.bkStrategy = d.strategy as typeof st.bkStrategy; await render(); }
    else if (d.cbperson !== undefined) { st.cbView = d.cbperson; scrollTo(0, 0); await render(); }
    else if (d.sporadic) { await api("/conduct/sporadic", { method: "POST", body: { ruleId: d.sporadic, personId: d.person, day: today(), active: d.val === "true" } }); toast(d.val === "true" ? "Tarefa ativada para hoje." : "Tarefa desativada."); await render(); }
    else if (d.blame) await blameDialog(d.blame, d.person!, d.day!);
    else if (d.plan) await planDialog(d.plan);
    else if (d.close) await closeDialog(d.close, d.month!);
    else if (d.template !== undefined) { const r = await api<{ created: string[]; paused: string[] }>("/conduct/template", { method: "POST" }); toast(r.created.length ? `Criadas ${r.created.length} tarefas e mesadas do modelo.` : "O modelo já estava aplicado."); await render(); }
    else if (d.settle) settleDialog(d.settle, Number(d.bal));
    else if (d.delentry) { if (confirm("Excluir este registro? Os pontos e a multa voltam.")) { await api(`/conduct/entries/${d.delentry}`, { method: "DELETE" }); toast("Registro excluído."); await render(); } }
    else if (d.newrule !== undefined) await editRule();
    else if (d.editrule) await editRule(d.editrule);
    else if (d.rkweek !== undefined) { const n = Number(d.rkweek); if (n === 0) st.rkDate = today(); else { const x = new Date(`${st.rkDate}T12:00:00`); x.setDate(x.getDate() + n); st.rkDate = x.toLocaleDateString("sv-SE"); } await render(); }
    else if (d.mand) { await api(`/titles/${d.mand}`, { method: "PATCH", body: { mandatory: d.val === "true" } }); toast("Classificação revisada."); await render(); }
    else if (d.editcats !== undefined) editCats((await api<string[]>("/settings/mandatory-categories")));
    else if (d.newuser !== undefined) newUser();
    else if (d.endsess) { if (confirm("Encerrar esta sessão? A pessoa terá que entrar de novo nesse aparelho.")) { await root(`/admin/sessions/${d.endsess}`, { method: "DELETE" }); toast("Sessão encerrada."); await render(); } }
    else if (d.edituser) editUser(d.edituser);
    else if (d.resetuser) resetUser(d.resetuser);
    else if (d.reset2fa) { if (confirm("Desligar a verificação em duas etapas desta pessoa? Use quando ela perdeu o celular. Ela vai entrar só com a senha e poderá ativar de novo.")) { await root(`/admin/users/${d.reset2fa}/reset-2fa`, { method: "POST" }); toast("Verificação em duas etapas desligada."); await render(); } }
    else if (d.mfaon !== undefined) await mfaSetup();
    else if (d.pushon !== undefined) { await pushOn(); await render(); }
    else if (d.pushoff !== undefined) { await pushOff(); await render(); }
    else if (d.pushtest !== undefined) { const r = await root<{ sent: number }>("/push/test", { method: "POST" }); toast(r.sent ? "Teste enviado. Deve chegar em segundos." : "Nenhum aparelho recebeu. Desligue e ligue de novo.", !r.sent); }
    else if (d.mfaoff !== undefined) mfaDisable();
    else if (d.toggleuser) { await root(`/admin/users/${d.toggleuser}`, { method: "PATCH", body: { active: d.active !== "true" } }); toast(d.active === "true" ? "Usuário desativado." : "Usuário reativado."); await render(); }
    else if (d.editperson) editPerson(d.editperson);
    else if (d.toggleperson) { await api(`/people/${d.toggleperson}`, { method: "PATCH", body: { active: d.active !== "true" } }); await render(); }
    else if (d.seeperson) { st.personFilter = d.seeperson; st.personFilterSet = true; st.statusFilter = "all"; st.tab = "pagar"; history.replaceState(null, "", "#pagar"); await render(); }
    else if (d.editrec) await editRec(d.editrec);
    else if (d.togglerec) { await api(`/recurrences/${d.togglerec}`, { method: "PATCH", body: { active: d.active !== "true" } }); await render(); }
  } catch (err) { fail(err); }
});
/** "acc:<id>" → conta de onde saiu/entrou; "card:<id>" → compra no cartão (vai para a fatura). */
export function srcOf(f: FormData): { accountId?: string; cardAccountId?: string } {
  const v = str(f, "src");
  if (v.startsWith("acc:")) return { accountId: v.slice(4) };
  if (v.startsWith("card:")) return { cardAccountId: v.slice(5) };
  return {};
}
view.addEventListener("change", async e => {
  const t = e.target as HTMLInputElement;
  if (t.matches("[data-rcfile]") && t.files?.[0]) { try { await sendReceipt(t.files[0]); await render(); } catch (err) { fail(err); } finally { t.value = ""; } return; }
  if (t.matches("[data-ofx]") && t.files?.[0]) { try { await importStatement(t.dataset.ofx!, t.files[0]); } catch (err) { fail(err); } finally { t.value = ""; } return; }
  if (t.matches("[data-importfile]") && t.files?.[0]) { try { await importFile(t.files[0]); } catch (err) { fail(err); } finally { t.value = ""; } }
});
view.addEventListener("submit", async e => {
  const form = e.target as HTMLFormElement;
  e.preventDefault();
  try {
    if (form.id === "quick") {
      const r = await submitExpense(new FormData(form));
      toast(r.msg, r.warn); await render();
    } else if (form.id === "quick-tr") {
      const f = new FormData(form);
      if (str(f, "from") === str(f, "to")) { toast("Escolha contas diferentes em De e Para.", true); return; }
      await api("/transfers", { method: "POST", body: { fromAccountId: str(f, "from"), toAccountId: str(f, "to"), amountCents: centsOf(f, "v"), day: str(f, "dt") || undefined } });
      toast("Transferência registrada."); await render();
    } else if (form.id === "bridge-f") {
      const f = new FormData(form);
      const r = await api<{ label: string }>("/bridge", { method: "POST", body: { kind: str(f, "k"), amountCents: centsOf(f, "v"), fromAccountId: str(f, "from"), toAccountId: str(f, "to"), date: str(f, "dt") || undefined } });
      toast(`${r.label} registrado: saiu da PJ e entrou no Pessoal.`); await render();
    } else if (form.id === "rep-f") {
      st.repMonth = str(new FormData(form), "m") || st.repMonth; await render();
    } else if (form.id === "req-f") {
      const f = new FormData(form);
      const body: Record<string, unknown> = { description: str(f, "d"), amountCents: centsOf(f, "v"), category: str(f, "c") || undefined, accountId: str(f, "a") || null };
      if (f.has("person")) body.forPersonId = str(f, "person") || null;
      await api("/requests", { method: "POST", body });
      toast("Pedido enviado. Você recebe a resposta aqui (e no celular, se os avisos estiverem ligados)."); await render();
    } else if (form.id === "budget-f") {
      const f = new FormData(form), cur = await api<Budget>("/budget"), old = new Map(cur.items.map(i => [i.category, i.limitCents]));
      let n = 0;
      for (const c of SPEND_CATS) {
        const raw = str(f, `b_${c}`), v = raw ? parseMoney(raw) : null;
        if (raw && (v == null || !Number.isFinite(v) || v <= 0)) { toast(`Valor inválido em ${c}.`, true); return; }
        if ((old.get(c) ?? null) !== v) { await api(`/budget/${c}`, { method: "PUT", body: { limitCents: v } }); n++; }
      }
      toast(n ? `Orçamento salvo (${n} categoria${n > 1 ? "s" : ""}).` : "Nada mudou."); await render();
    } else if (form.id === "audit-f") {
      const f = new FormData(form); st.auditQ = { actor: str(f, "actor"), area: str(f, "area"), from: str(f, "from"), to: str(f, "to") }; await render();
    } else if (form.id === "ret-f") {
      const months = Number(str(new FormData(form), "m"));
      await root("/admin/audit/retention", { method: "PUT", body: { months } }); toast(months ? `Registro guardado por ${months} ${months === 1 ? "mês" : "meses"}.` : "Registro guardado sem limite."); await render();
    } else if (form.id === "quick-in") {
      const f = new FormData(form);
      const src = srcOf(f);
      await api("/incomes/quick", { method: "POST", body: { amountCents: centsOf(f, "v"), description: str(f, "d"), category: str(f, "c"), date: str(f, "dt") || undefined, personId: str(f, "person") || null, accountId: src.accountId ?? null } });
      toast("Recebimento registrado."); await render();
    } else if (form.id === "ext") {
      const f = new FormData(form); st.extFrom = str(f, "from") || st.extFrom; st.extTo = str(f, "to") || st.extTo;
      if (st.extFrom > st.extTo) [st.extFrom, st.extTo] = [st.extTo, st.extFrom];
      await render();
    } else if (form.id === "sim") await runSim(form);
    else if (form.id === "juros") runJuros(form);
    else if (form.id === "pmonth") { st.peopleMonth = str(new FormData(form), "m") || st.peopleMonth; await render(); }
  } catch (err) { fail(err); }
});

/* ===================== Aparência: paleta + tema ===================== */
export const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem storage */ } } };
export const darkMq = matchMedia("(prefers-color-scheme: dark)");
export const modeSel = $<HTMLSelectElement>("#mode");
export function applyLook() {
  const palette = store.get("palette") ?? "verde", mode = store.get("mode") ?? "auto";
  const root = document.documentElement;
  root.dataset.palette = palette;
  root.dataset.mode = mode === "dark" || (mode === "auto" && darkMq.matches) ? "dark" : "light";
  modeSel.value = mode;
  document.querySelectorAll<HTMLButtonElement>(".palettes button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.palette === palette)));
}
$(".palettes").addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-palette]");
  if (b) { store.set("palette", b.dataset.palette!); applyLook(); }
});
modeSel.addEventListener("change", () => { store.set("mode", modeSel.value); applyLook(); });
darkMq.addEventListener("change", applyLook);
applyLook();

view.addEventListener("change", e => {
  const el = e.target as HTMLSelectElement;
});

root<Me>("/auth/me").then(enter).catch(showLogin);
