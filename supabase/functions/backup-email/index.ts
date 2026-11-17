// Cópia de segurança semanal por email (Viana3D)
// - Chamada todos os dias pelo pg_cron (cabeçalho x-cron-secret): envia às empresas cujo dia da semana é hoje.
// - Chamada pela app (sessão do dono, {workspace}): envia já, para testar.
// O email é enviado pelo Resend com a chave guardada pelo dono na app (tabela private.backup_mail).
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const COL_NAMES: Record<string, string> = { quotes: "Orçamentos", orders: "Encomendas", plan: "Impressões planeadas", jobs: "Impressões registadas", parts: "Peças e artigos", clients: "Clientes", spools: "Bobines", purchases: "Compras", stock: "Materiais em stock", printers: "Impressoras", maint: "Manutenções", config: "Definições" };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${fn}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function allRows(ws: string) {
  const rows: { collection: string; id: string; data: unknown }[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${URL_}/rest/v1/docs?workspace_id=eq.${ws}&select=collection,id,data&order=collection,id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`docs: ${await r.text()}`);
    const d = await r.json();
    rows.push(...d);
    if (d.length < 1000) break;
  }
  return rows.filter((r) => !(r.collection === "config" && r.id === "backup"));
}
const lisbonDate = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" });
const slug = (s: string) => (s || "viana3d").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "viana3d";
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Target = { workspace_id: string; email: string; key: string | null; weekday: number; enabled: boolean; last_sent_at: string | null; company: string };

async function sendOne(t: Target) {
  if (!t.key) throw new Error("Falta a chave do Resend.");
  const rows = await allRows(t.workspace_id);
  const by: Record<string, number> = {};
  rows.forEach((r) => { by[r.collection] = (by[r.collection] || 0) + 1; });
  const date = lisbonDate(), [y, m, d] = date.split("-");
  const file = { app: "viana3d", formato: 1, criadaEm: new Date().toISOString(), empresa: t.company || "", por: "cópia automática por email", registos: rows.length, porColecao: by, docs: rows };
  const filename = `${slug(t.company)}-copia-${date}.json`;
  const content = encodeBase64(new TextEncoder().encode(JSON.stringify(file)));
  const list = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td style="padding:2px 16px 2px 0">${esc(COL_NAMES[k] || k)}</td><td style="text-align:right">${n}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1c2220">
    <p>Segue em anexo a cópia de segurança semanal de <b>${esc(t.company || "Viana3D")}</b>, feita a ${d}/${m}/${y}, com <b>${rows.length}</b> registos.</p>
    <table style="font-size:13px;border-collapse:collapse">${list}</table>
    <p>Guarde este email (ou o ficheiro <b>${esc(filename)}</b>). Para recuperar os dados: na aplicação, <i>Definições → Cópia de segurança → Repor a partir de uma cópia…</i></p>
    <p style="color:#68726e;font-size:12px">O ficheiro contém os dados da empresa e dos clientes. Não o reencaminhe.</p></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Cópia de segurança Viana3D <onboarding@resend.dev>", to: [t.email], subject: `Cópia de segurança ${t.company || "Viana3D"} · ${d}/${m}/${y}`, html, attachments: [{ filename, content }] }),
  });
  if (!r.ok) {
    let msg = await r.text();
    try { const j = JSON.parse(msg); msg = j.message || msg; } catch (_) { /* texto */ }
    if (r.status === 401 || (r.status === 400 && /api key/i.test(msg))) msg = "A chave do Resend não é válida. " + msg;
    if (r.status === 403) msg = "O Resend só deixa enviar para o email com que criou a conta (ou para um domínio verificado). " + msg;
    throw new Error(msg);
  }
  return rows.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const cron = req.headers.get("x-cron-secret");
    let targets: Target[] = [], force = false;
    if (cron) {
      if (!(await rpc("backup_cron_ok", { p_secret: cron }))) return json({ error: "não autorizado" }, 401);
      targets = (await rpc("backup_mail_targets", { p_ws: null })) || [];
    } else {
      const auth = req.headers.get("Authorization") || "";
      const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: SR, Authorization: auth } });
      if (!u.ok) return json({ error: "Sessão inválida." }, 401);
      const user = await u.json(), ws = String(body.workspace || "");
      if (!/^[0-9a-f-]{36}$/.test(ws)) return json({ error: "Empresa inválida." }, 400);
      const m = await fetch(`${URL_}/rest/v1/workspace_members?workspace_id=eq.${ws}&user_id=eq.${user.id}&role=eq.dono&select=user_id`, { headers: H });
      if (!m.ok || !(await m.json()).length) return json({ error: "Só o dono pode enviar a cópia." }, 403);
      targets = (await rpc("backup_mail_targets", { p_ws: ws })) || [];
      if (!targets.length) return json({ error: "Grave primeiro o email e a chave do Resend." }, 400);
      force = true;
    }
    const today = lisbonDate(), wd = new Date(today + "T12:00:00Z").getUTCDay(), out = [];
    for (const t of targets) {
      if (!force) {
        if (!t.enabled) continue;
        const age = t.last_sent_at ? (Date.now() - new Date(t.last_sent_at).getTime()) / 864e5 : null;
        const due = (wd === t.weekday && (age === null || age > 5)) || (age !== null && age > 8);
        if (!due) continue;
      }
      try {
        const n = await sendOne(t);
        await rpc("backup_mail_done", { p_ws: t.workspace_id, p_ok: true, p_error: null, p_count: n });
        out.push({ workspace: t.workspace_id, ok: true, registos: n });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await rpc("backup_mail_done", { p_ws: t.workspace_id, p_ok: false, p_error: msg, p_count: 0 }).catch(() => {});
        out.push({ workspace: t.workspace_id, ok: false, error: msg });
      }
    }
    if (force && out[0] && !out[0].ok) return json({ error: out[0].error }, 502);
    return json({ ok: true, enviados: out });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
