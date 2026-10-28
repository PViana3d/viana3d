/// <reference path="../pb_data/types.d.ts" />
// Rotas próprias da aplicação Viana 3D.

// A aplicação pergunta se já existe alguma conta (para mostrar o ecrã de configuração inicial).
routerAdd("GET", "/api/viana3d/estado", (e) => {
  return e.json(200, { configurado: $app.countRecords("users") > 0, versao: 1 });
});

// Criação da primeira conta (o dono). Só funciona enquanto não existir nenhuma conta.
routerAdd("POST", "/api/viana3d/primeiro-dono", (e) => {
  const body = e.requestInfo().body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim().slice(0, 100);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestError("Indique um email válido.");
  if (password.length < 8) throw new BadRequestError("A palavra-passe tem de ter pelo menos 8 caracteres.");

  $app.runInTransaction((txApp) => {
    if (txApp.countRecords("users") > 0) throw new ForbiddenError("A aplicação já está configurada. Entre com a sua conta.");
    const record = new Record(txApp.findCollectionByNameOrId("users"));
    record.setEmail(email);
    record.setPassword(password);
    record.setVerified(true);
    record.setEmailVisibility(true);
    record.set("name", name);
    record.set("role", "dono");
    txApp.save(record);
  });

  return e.json(200, { ok: true });
});
