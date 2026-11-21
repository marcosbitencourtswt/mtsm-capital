/** Cliente da API. Dinheiro sempre em centavos inteiros. */

export type Kind = "PAYABLE" | "RECEIVABLE";
export type Nature = "EXPENSE" | "DEBT" | "CARD" | "INCOME" | "LOAN_IN";
export type Status = "OPEN" | "OVERDUE" | "SETTLED" | "NO_VALUE";

export interface Settlement { id: string; amountCents: number; paidOn: string; method: "ACCOUNT" | "CARD"; notes: string | null; warnings: string[]; }
export interface Title {
  id: string; kind: Kind; nature: Nature; counterparty: string; category: string;
  amountCents: number; interestModel: string; rateBp: number; dueDate: string | null; startDate: string;
  interestCents: number; totalCents: number; settledCents: number; openCents: number; status: Status;
  competenceMonth: string | null; recurrenceId: string | null; linkedTitleId: string | null; notes: string | null;
  personId: string | null; personName: string | null; createdBy: string | null; mandatory: boolean | null;
  settlements?: Settlement[];
}
export interface Recurrence { id: string; kind: Kind; nature: "EXPENSE" | "INCOME"; description: string; category: string; defaultAmountCents: number | null; dueDay: number | null; startMonth: string; endMonth: string | null; active: boolean; personId: string | null; personName: string | null; }
export interface Person { id: string; name: string; relation: string | null; active: boolean; }

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

let entity = "personal";
try { entity = localStorage.getItem("entity") ?? "personal"; } catch { /* sem storage */ }
export const getEntity = () => entity;
export function setEntity(e: string) { entity = e; try { localStorage.setItem("entity", e); } catch { /* ok */ } }

export interface Me { id: string; email: string; name: string; nickname: string | null; role: "ADMIN" | "MEMBER"; personId: string | null; mustChangePassword: boolean; isGuardian: boolean; isRoot: boolean; }

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
async function request<T>(url: string, init: Init = {}): Promise<T> {
  const r = await fetch(url, {
    method: init.method ?? "GET", credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (r.status === 401 && !url.endsWith("/auth/login")) window.dispatchEvent(new Event("nf:unauthenticated"));
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, data?.error?.code ?? "HTTP", data?.error?.message ?? `Erro ${r.status}`);
  return data as T;
}
/** Rotas da entidade atual: /api/v1/{personal|byte4tech}/... */
export const api = <T>(path: string, init: Init = {}) => request<T>(`/api/v1/${entity}${path}`, init);
/** Rotas gerais: /api/v1/auth/..., /api/v1/admin/... */
export const root = <T>(path: string, init: Init = {}) => request<T>(`/api/v1${path}`, init);
