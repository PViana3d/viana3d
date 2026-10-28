/// <reference path="../pb_data/types.d.ts" />
// Estrutura inicial da base de dados da aplicação Viana 3D.
// - users: contas da equipa (papel "dono" ou "membro"); não há registo público.
// - docs: todos os registos da aplicação (orçamentos, peças, clientes, …) em JSON.

const AUTH = '@request.auth.id != "" && @request.auth.collectionName = "users"';
const DONO = '@request.auth.collectionName = "users" && @request.auth.role = "dono"';

migrate((app) => {
  // ---------- equipa ----------
  const users = app.findCollectionByNameOrId("users");
  if (!users.fields.getByName("role")) {
    users.fields.add(new SelectField({ name: "role", values: ["dono", "membro"], maxSelect: 1 }));
  }
  users.listRule = AUTH;
  users.viewRule = AUTH;
  users.createRule = DONO;                                   // só o dono cria contas
  users.updateRule = `(id = @request.auth.id && @request.body.role:isset = false) || (${DONO})`; // ninguém se promove a si próprio
  users.deleteRule = `(${DONO}) && id != @request.auth.id`;
  users.manageRule = DONO;                                   // o dono pode definir palavras-passe da equipa
  users.authAlert.enabled = false;                           // sem servidor de email por defeito
  users.oauth2.enabled = false;
  users.otp.enabled = false;
  users.passwordAuth.enabled = true;
  app.save(users);

  // ---------- registos da aplicação ----------
  let docs = null;
  try { docs = app.findCollectionByNameOrId("docs"); } catch (_) {}
  if (!docs) {
    docs = new Collection({
      type: "base",
      name: "docs",
      listRule: AUTH,
      viewRule: AUTH,
      createRule: AUTH,
      updateRule: AUTH,
      deleteRule: AUTH,
      fields: [
        { name: "coll", type: "text", required: true, max: 40 },
        { name: "ref", type: "text", required: true, max: 120 },
        { name: "data", type: "json", maxSize: 5000000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_docs_coll_ref ON docs (coll, ref)"],
    });
    app.save(docs);
  }

  // ---------- definições do servidor ----------
  const s = app.settings();
  s.meta.appName = "Viana 3D";
  s.backups.cron = "0 3 * * *";       // cópia de segurança todos os dias às 03:00
  s.backups.cronMaxKeep = 14;          // guarda as últimas 14
  s.logs.maxDays = 7;
  s.trustedProxy.headers = ["X-Forwarded-For"]; // o Tailscale Funnel indica o IP real do visitante
  s.trustedProxy.useLeftmostIP = false;
  s.rateLimits.enabled = true;          // trava tentativas repetidas de adivinhar palavras-passe
  s.rateLimits.rules = [
    { label: "*:auth", maxRequests: 5, duration: 10 },
    { label: "/api/viana3d/primeiro-dono", maxRequests: 3, duration: 60 },
    { label: "*:create", maxRequests: 120, duration: 10 },
    { label: "/api/batch", maxRequests: 10, duration: 1 },
    { label: "/api/", maxRequests: 900, duration: 10 },
  ];
  app.save(s);
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("docs")); } catch (_) {}
  const users = app.findCollectionByNameOrId("users");
  const f = users.fields.getByName("role");
  if (f) users.fields.removeById(f.id);
  app.save(users);
});
