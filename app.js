/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cp = o => JSON.parse(JSON.stringify(o));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const eurF = new Intl.NumberFormat('pt-PT', {style:'currency', currency:'EUR'});
const eur = n => eurF.format(+n || 0);
const num = (n, d = 0) => new Intl.NumberFormat('pt-PT', {minimumFractionDigits:d, maximumFractionDigits:d}).format(+n || 0);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
const fmtDate = d => d ? new Date(d + 'T12:00').toLocaleDateString('pt-PT', {day:'2-digit', month:'short', year:'numeric'}) : '—';
const hm = h => { h = +h || 0; const H = Math.floor(h), M = Math.round((h - H) * 60); return M === 60 ? `${H+1}h00` : `${H}h${String(M).padStart(2,'0')}`; };
const r2 = n => Math.round((+n || 0) * 100) / 100;
const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
const numv = id => parseFloat(String(val(id)).replace(',', '.')) || 0;

const MAT_COLORS = {PLA:'#4C8BF5', PETG:'#0A9E8F', ABS:'#D9822B', ASA:'#B05FD0', TPU:'#D9466F', Resina:'#7C8A2E', Outro:'#7A8784'};
const DEF = {company:'Oficina 3D', kwh:0.16, labor:15, margin:40, failure:10, vat:23, low:150, delivery:5,
  matPrices:{PLA:20, PETG:22, ABS:22, ASA:28, TPU:30, Resina:35},
  cNif:'', cAddress:'', cPhone:'', cEmail:'', cWeb:'', cIban:'', logo:'', pdfColor:'#0A7470',
  cond:'Pagamento: 50% na adjudicação e 50% na entrega.\nPreços em euros. Portes de envio não incluídos, salvo indicação em contrário.'};
const COLS = ['spools','printers','maint','jobs','quotes','clients','parts','orders','plan'];
const S = {spools:[], printers:[], maint:[], jobs:[], quotes:[], clients:[], parts:[], orders:[], plan:[], settings:cp(DEF)};
const QSTATUS = {rascunho:['Rascunho',''], enviado:['Enviado','info'], aceite:['Aceite','ok'], recusado:['Recusado','bad']};
const DEFAULT_TASKS = [['Limpeza da base e bico', 50], ['Lubrificação dos eixos', 200], ['Verificar tensão das correias', 300], ['Troca de bico', 500]];

let loaded = false, writeBlocked = false;

/* ---------- armazenamento (Supabase) ---------- */
// Todos os registos ficam numa tabela "docs" (workspace, coleção, id, dados JSON).
// Cada empresa é um "workspace"; os membros da equipa veem e alteram os mesmos dados.
const CFG = window.APP_CONFIG || {};
let sb = null, WS = null, ME = null, ROLE = 'membro', online = navigator.onLine, channel = null;
const cacheKey = () => `g3d-cache-${WS}`;
function saveCache(){ try{ localStorage.setItem(cacheKey(), JSON.stringify(S)); }catch(e){} }
function loadCache(){ try{ const d = JSON.parse(localStorage.getItem(cacheKey()) || 'null'); if (d){ COLS.concat('settings').forEach(k => { if (d[k]) S[k] = d[k]; }); return true; } }catch(e){} return false; }
function applyRow(col, id, data){
  if (col === 'config'){ if (id === 'settings') S.settings = data ? cp(data) : cp(DEF); return; }
  if (!S[col]) return;
  const a = S[col], i = a.findIndex(x => x.id === id);
  if (!data){ if (i >= 0) a.splice(i, 1); return; }
  const o = {...cp(data), id};
  if (i >= 0) a[i] = o; else a.push(o);
}
function dbErr(error){
  const msg = String(error && (error.message || error.code) || '');
  if (!navigator.onLine || /fetch|network/i.test(msg)) toast('Sem ligação à internet. A alteração não foi guardada.');
  else if (/row-level security|permission|42501/i.test(msg)) toast('Não tem permissão para alterar estes dados.');
  else toast('Não foi possível guardar: ' + msg);
  throw error || new Error('save');
}
async function put(col, obj){
  obj = cp(obj);
  applyRow(col, obj.id, obj); saveCache(); scheduleRender();
  const {error} = await sb.from('docs').upsert({workspace_id:WS, collection:col, id:obj.id, data:obj});
  if (error){ await refetch(); dbErr(error); }
}
async function del(col, id){
  applyRow(col, id, null); saveCache(); scheduleRender();
  const {error} = await sb.from('docs').delete().match({workspace_id:WS, collection:col, id});
  if (error){ await refetch(); dbErr(error); }
}
async function putSettings(s){ await put('config', {...cp(s), id:'settings'}); }
const settings = () => ({...DEF, ...S.settings, matPrices:{...DEF.matPrices, ...(S.settings.matPrices || {})}});

let rTimer = null;
function scheduleRender(){ clearTimeout(rTimer); rTimer = setTimeout(render, 40); }

async function refetch(){
  const fresh = {settings:cp(DEF)}; COLS.forEach(c => fresh[c] = []);
  for (let from = 0; ; from += 1000){
    const {data, error} = await sb.from('docs').select('collection,id,data').eq('workspace_id', WS).order('collection').order('id').range(from, from + 999);
    if (error) throw error;
    data.forEach(r => {
      if (r.collection === 'config'){ if (r.id === 'settings') fresh.settings = r.data; }
      else if (fresh[r.collection]) fresh[r.collection].push({...r.data, id:r.id});
    });
    if (data.length < 1000) break;
  }
  Object.assign(S, fresh); saveCache();
}
function subscribe(){
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('docs-' + WS)
    .on('postgres_changes', {event:'*', schema:'public', table:'docs', filter:`workspace_id=eq.${WS}`}, p => {
      const row = p.eventType === 'DELETE' ? p.old : p.new;
      if (!row || (row.workspace_id && row.workspace_id !== WS)) return;
      applyRow(row.collection, row.id, p.eventType === 'DELETE' ? null : row.data); saveCache(); scheduleRender();
    })
    .subscribe(status => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setTimeout(subscribe, 5000); });
}

/* ---------- início de sessão ---------- */
function showAuth(mode = 'login', msg = ''){
  document.body.classList.add('auth-mode');
  const box = $('#auth');
  box.hidden = false; $('#app').hidden = true;
  const title = {login:'Entrar', signup:'Criar conta', reset:'Recuperar palavra-passe', newpass:'Nova palavra-passe'}[mode];
  box.innerHTML = `<form class="auth-card" id="auth-form" data-mode="${mode}" novalidate>
    <div class="auth-brand"><img src="icons/icon-192.png" alt="" width="48" height="48"><div><b>Gestão Impressão 3D</b><small>Orçamentos, encomendas e produção</small></div></div>
    <h1>${title}</h1>
    ${msg ? `<p class="auth-msg">${esc(msg)}</p>` : ''}
    ${mode !== 'newpass' ? `<div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>` : ''}
    ${mode === 'login' || mode === 'signup' || mode === 'newpass' ? `<div class="field"><label for="a-pass">Palavra-passe</label><input id="a-pass" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required>${mode !== 'login' ? '<span class="hint">Pelo menos 8 caracteres.</span>' : ''}</div>` : ''}
    <button class="btn primary" type="submit">${mode === 'login' ? 'Entrar' : mode === 'signup' ? 'Criar conta' : mode === 'reset' ? 'Enviar link de recuperação' : 'Guardar palavra-passe'}</button>
    <div class="auth-links">
      ${mode === 'login' ? '<button type="button" class="linkbtn2" data-auth="signup">Criar conta</button><button type="button" class="linkbtn2" data-auth="reset">Esqueci-me da palavra-passe</button>' : '<button type="button" class="linkbtn2" data-auth="login">Voltar a entrar</button>'}
    </div>
    ${mode === 'signup' ? '<p class="hint">Se foi convidado por um colega, use o mesmo email do convite: entra logo na equipa dele.</p>' : ''}
  </form>`;
  const f = box.querySelector('input'); if (f) f.focus();
}
async function authSubmit(form){
  const mode = form.dataset.mode, email = val('a-email').trim(), pass = val('a-pass');
  const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
  try{
    if (mode === 'login'){
      const {error} = await sb.auth.signInWithPassword({email, password:pass});
      if (error) return showAuth('login', /confirm/i.test(error.message) ? 'Confirme primeiro o seu email (veja a caixa de correio).' : 'Email ou palavra-passe errados.');
    } else if (mode === 'signup'){
      if (pass.length < 8) return showAuth('signup', 'A palavra-passe tem de ter pelo menos 8 caracteres.');
      const {data, error} = await sb.auth.signUp({email, password:pass, options:{emailRedirectTo:location.origin + location.pathname}});
      if (error) return showAuth('signup', error.message);
      if (!data.session) return showAuth('login', 'Conta criada. Enviámos um email de confirmação: abra o link e depois entre aqui.');
    } else if (mode === 'reset'){
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo:location.origin + location.pathname});
      return showAuth('login', error ? error.message : 'Se o email existir, recebe um link para definir nova palavra-passe.');
    } else if (mode === 'newpass'){
      if (pass.length < 8) return showAuth('newpass', 'A palavra-passe tem de ter pelo menos 8 caracteres.');
      const {error} = await sb.auth.updateUser({password:pass});
      if (error) return showAuth('newpass', error.message);
      toast('Palavra-passe alterada.'); await startSession();
    }
  } finally { btn.disabled = false; }
}
document.addEventListener('click', e => { const b = e.target.closest('[data-auth]'); if (b) showAuth(b.dataset.auth); });
document.addEventListener('submit', e => { if (e.target.id === 'auth-form'){ e.preventDefault(); e.stopImmediatePropagation(); authSubmit(e.target); } }, true);

let sessionBusy = null;
function startSession(){ if (!sessionBusy) sessionBusy = runSession().finally(() => { sessionBusy = null; }); return sessionBusy; }
async function runSession(){
  const {data:{session}} = await sb.auth.getSession();
  if (!session){ showAuth('login'); return; }
  ME = session.user;
  document.body.classList.remove('auth-mode'); $('#auth').hidden = true; $('#app').hidden = false;
  // workspace: lembrado neste aparelho para abrir já com os dados em cache
  WS = localStorage.getItem('g3d-ws-' + ME.id);
  if (WS && loadCache()){ loaded = true; render(); }
  else render();
  try{
    const {data, error} = await sb.rpc('bootstrap');
    if (error) throw error;
    WS = data.workspace_id; ROLE = data.role || 'membro';
    localStorage.setItem('g3d-ws-' + ME.id, WS);
    if (!loaded) loadCache();
    await refetch(); loaded = true; subscribe(); render();
  }catch(err){
    if (loaded){ online = false; render(); toast('Sem ligação: a mostrar os dados guardados neste aparelho.'); }
    else { $('#view').innerHTML = `<div class="empty"><b>Não foi possível ligar ao servidor.</b><span>${esc(err.message || '')}</span><button class="btn" onclick="location.reload()">Tentar de novo</button></div>`; }
  }
}
async function signOut(){
  if (channel) sb.removeChannel(channel);
  await sb.auth.signOut();
  Object.assign(S, {settings:cp(DEF)}); COLS.forEach(c => S[c] = []); loaded = false; WS = null;
  showAuth('login', 'Sessão terminada.');
}

/* ---------- equipa ---------- */
async function loadTeam(){
  const [m, i] = await Promise.all([
    sb.from('workspace_members').select('user_id,email,role,created_at').eq('workspace_id', WS).order('created_at'),
    sb.from('workspace_invites').select('email,role,created_at').eq('workspace_id', WS).order('created_at')]);
  return {members:m.data || [], invites:i.data || []};
}
async function renderTeam(){
  const box = $('#team'); if (!box) return;
  let t; try{ t = await loadTeam(); }catch(e){ box.innerHTML = '<p class="muted">Sem ligação.</p>'; return; }
  const owner = ROLE === 'dono';
  box.innerHTML = `<ul class="alerts">${t.members.map(m => `<li><span class="pill ${m.role === 'dono' ? 'info' : ''}">${m.role === 'dono' ? 'Dono' : 'Membro'}</span><div class="txt">${esc(m.email || '—')}${m.user_id === ME.id ? ' <small>(você)</small>' : ''}</div>${owner && m.user_id !== ME.id ? `<button type="button" class="btn ghost sm danger" data-act="team-rm" data-id="${m.user_id}">Remover</button>` : ''}</li>`).join('')}
    ${t.invites.map(i => `<li><span class="pill warn">Convidado</span><div class="txt">${esc(i.email)}<small>Ainda não criou conta</small></div>${owner ? `<button type="button" class="btn ghost sm" data-act="team-uninvite" data-id="${esc(i.email)}">Cancelar</button>` : ''}</li>`).join('')}</ul>
    ${owner ? `<div class="addpart"><input id="team-email" type="email" placeholder="email do colega" aria-label="Email do colega"><button type="button" class="btn" data-act="team-invite">Convidar</button></div><p class="hint muted" style="margin:0">O colega cria conta na aplicação com este email e entra automaticamente na equipa.</p>` : '<p class="hint muted">Só o dono da conta pode convidar ou remover pessoas.</p>'}`;
}
async function teamAction(a, id){
  if (a === 'team-invite'){
    const email = val('team-email').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)){ toast('Indique um email válido.'); return; }
    const {data, error} = await sb.rpc('invite_member', {ws:WS, mail:email});
    if (error){ toast(error.message); return; }
    toast(data === 'added' ? 'Adicionado à equipa.' : 'Convite registado. Peça ao colega para criar conta com este email.');
  } else if (a === 'team-uninvite'){
    const {error} = await sb.from('workspace_invites').delete().match({workspace_id:WS, email:id}); if (error){ toast(error.message); return; }
  } else if (a === 'team-rm'){
    const {error} = await sb.from('workspace_members').delete().match({workspace_id:WS, user_id:id}); if (error){ toast(error.message); return; }
    toast('Removido da equipa.');
  }
  renderTeam();
}

/* ---------- ficheiros: guardar e partilhar ---------- */
const downloads = {
  async save({filename, data, type}){
    const blob = data instanceof Blob ? data : new Blob([data], {type: type || (/\.pdf$/i.test(filename) ? 'application/pdf' : /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream')});
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
};
function canShareFile(file){ try{ return !!(navigator.canShare && navigator.canShare({files:[file]})); }catch(e){ return false; } }

async function init(){
  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => { online = true; if (WS) refetch().then(render).catch(() => {}); render(); });
  window.addEventListener('offline', () => { online = false; render(); });
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase){
    $('#auth').hidden = false; $('#app').hidden = true;
    $('#auth').innerHTML = '<div class="auth-card"><h1>Falta configurar</h1><p>Indique o endereço e a chave pública do Supabase no ficheiro <code>config.js</code> (ver README).</p></div>';
    return;
  }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') showAuth('newpass', 'Escolha uma nova palavra-passe.');
    if (event === 'SIGNED_IN' && !WS) startSession();
  });
  await startSession();
}

/* ---------- cálculos ---------- */
const spoolLabel = s => `${s.material} · ${s.color}`;
const spoolEurKg = s => s && s.weight ? s.price / s.weight * 1000 : 0;
const spoolRemain = s => Math.max(0, +s.remaining || 0);
function spoolStatus(s){
  const r = spoolRemain(s), low = settings().low;
  if (r <= 0) return ['Esgotada','bad'];
  if (r <= low) return ['Stock baixo','warn'];
  return ['Disponível','ok'];
}
function taskState(p, t){
  const since = (+p.hours || 0) - (+t.last || 0), pct = t.interval ? since / t.interval : 0;
  return {since, pct, cls: pct >= 1 ? 'bad' : pct >= .85 ? 'warn' : ''};
}
function matEurKg(code){
  const s = settings();
  if (!code) return 0;
  if (code.startsWith('s:')){ const sp = S.spools.find(x => x.id === code.slice(2)); return sp ? spoolEurKg(sp) : 0; }
  return s.matPrices[code.slice(2)] || 0;
}
function matLabel(code){
  if (!code) return '—';
  if (code.startsWith('s:')){ const sp = S.spools.find(x => x.id === code.slice(2)); return sp ? spoolLabel(sp) : 'Bobine removida'; }
  return code.slice(2) + ' (genérico)';
}
/* ---------- vários filamentos por peça (até 20) ---------- */
const MAXF = 20;
// lista de filamentos de uma peça / linha de orçamento / impressão planeada (aceita o formato antigo de um só filamento)
function filsOf(x){
  if (x && Array.isArray(x.fils) && x.fils.length) return x.fils.slice(0, MAXF).map(f => ({mat:f.mat || '', grams:+f.grams || 0, hex:f.hex || '', spoolId:f.spoolId || ''}));
  return [{mat:(x && x.mat) || '', grams:+(x && x.grams) || 0, hex:'', spoolId:(x && x.spoolId) || ''}];
}
const sumG = fs => fs.reduce((a, f) => a + (+f.grams || 0), 0);
function withFils(x, fils){ fils = fils.slice(0, MAXF); return {...x, fils, grams:r2(sumG(fils)), mat:(fils[0] || {}).mat || ''}; }
// bobines gastas numa impressão registada
function usesOf(j){
  if (j && Array.isArray(j.uses) && j.uses.length) return j.uses.map(u => ({spoolId:u.spoolId || '', grams:+u.grams || 0}));
  return j && (j.spoolId || +j.grams) ? [{spoolId:j.spoolId || '', grams:+j.grams || 0}] : [];
}
const spoolHex = id => (S.spools.find(s => s.id === id) || {}).hex || '';
const matHex = code => code && code.startsWith('s:') ? spoolHex(code.slice(2)) : '';
const swatch = hex => `<i class="sw" style="background:${esc(hex || 'transparent')}"></i>`;
// distância entre duas cores #rrggbb (0 = iguais)
function hexDist(a, b){ const p = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : null; }; const x = p(a), y = p(b); if (!x || !y) return 999; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }
// melhor bobine para um material (e cor, se conhecida) com filamento suficiente
function bestSpool(type, hex, need){
  const list = S.spools.filter(s => s.material === type && spoolRemain(s) > 0);
  if (!list.length) return null;
  const enough = list.filter(s => spoolRemain(s) >= (need || 0)), pool = enough.length ? enough : list;
  return pool.slice().sort((a, b) => (hex ? hexDist(a.hex, hex) - hexDist(b.hex, hex) : 0) || spoolRemain(b) - spoolRemain(a))[0];
}
const filsText = x => [...new Set(filsOf(x).map(f => matLabel(f.mat)))].join(', ');
const filsTypes = x => [...new Set(filsOf(x).map(f => matType(f.mat)).filter(Boolean))].join(' + ');

function calcQuote(q){
  const s = settings();
  const pr = S.printers.find(p => p.id === q.printerId) || {};
  const watts = +pr.watts || 0, wearH = pr.price && pr.life ? pr.price / pr.life : 0;
  const rate = q.laborRate == null || q.laborRate === '' ? s.labor : +q.laborRate || 0;
  const fail = (+q.failure || 0) / 100, mk = 1 + (+q.margin || 0) / 100;
  const lines = (q.items || []).map(it => {
    const qty = Math.max(0, +it.qty || 0), fl = filsOf(it), g = sumG(fl), h = +it.hours || 0;
    const material = fl.reduce((a, f) => a + f.grams / 1000 * matEurKg(f.mat), 0), energy = h * watts / 1000 * s.kwh, machine = h * wearH;
    const failure = (material + energy + machine) * fail, labor = (+it.laborH || 0) * rate;
    const unitCost = material + energy + machine + failure + labor, unitPrice = unitCost * mk;
    const gross = unitPrice * qty, disc = gross * Math.min(100, Math.max(0, +it.disc || 0)) / 100;
    return {qty, grams:g * qty, hours:h * qty, material:material * qty, energy:energy * qty, machine:machine * qty, failure:failure * qty, labor:labor * qty, cost:unitCost * qty, unitPrice, gross, disc, net:gross - disc};
  });
  const sum = k => lines.reduce((a, l) => a + l[k], 0);
  const extraLabor = (+q.laborH || 0) * rate, extraLaborPrice = extraLabor * mk, extras = +q.extras || 0;
  const cost = sum('cost') + extraLabor + extras;
  const gross = sum('gross') + extraLaborPrice + extras;
  const discount = sum('disc'), net = gross - discount, profit = net - cost;
  const vat = q.vat ? net * s.vat / 100 : 0;
  return {lines, rate, material:sum('material'), energy:sum('energy'), machine:sum('machine'), failure:sum('failure'), labor:sum('labor') + extraLabor, extraLaborPrice, extras,
    cost, gross, discount, net, profit, vat, total:r2(net + vat), grams:sum('grams'), hours:sum('hours')};
}
const monthOf = d => (d || '').slice(0, 7);
function jobsIn(month, printerId){ return S.jobs.filter(j => monthOf(j.date) === month && (!printerId || j.printerId === printerId)); }
function stats(jobs){
  const ok = jobs.filter(j => j.result === 'sucesso').length;
  const jg = j => sumG(usesOf(j));
  const grams = jobs.reduce((a, j) => a + jg(j), 0);
  const hours = jobs.reduce((a, j) => a + (+j.hours || 0), 0);
  const matCost = jobs.reduce((a, j) => a + usesOf(j).reduce((b, u) => b + u.grams / 1000 * spoolEurKg(S.spools.find(s => s.id === u.spoolId)), 0), 0);
  const wasted = jobs.filter(j => j.result === 'falha').reduce((a, j) => a + jg(j), 0);
  return {n: jobs.length, ok, rate: jobs.length ? ok / jobs.length * 100 : 0, grams, hours, matCost, wasted};
}
function alerts(){
  const out = [];
  S.spools.forEach(s => { const [t, c] = spoolStatus(s); if (c !== 'ok') out.push({cls:c, title:`${spoolLabel(s)} (${s.brand || 'sem marca'})`, sub:`${t}: restam ${num(spoolRemain(s))} g`, href:'#bobines'}); });
  S.printers.forEach(p => (p.tasks || []).forEach(t => { const st = taskState(p, t); if (st.cls) out.push({cls:st.cls, title:`${p.name}: ${t.name}`, sub: st.pct >= 1 ? `Em atraso ${num(st.since - t.interval)} h` : `Faltam ${num(t.interval - st.since)} h`, href:'#manutencao'}); }));
  S.quotes.filter(q => q.status === 'enviado').forEach(q => out.push({cls:'info', title:`Orçamento ${q.number} · ${clientName(q) || 'sem cliente'}`, sub:`Enviado a ${fmtDate(q.date)}, a aguardar resposta`, href:'#orcamentos'}));
  S.orders.forEach(o => { const s = orderState(o); if (!s.open) return; const dl = o.due ? businessDaysBetween(today(), o.due) : 99;
    if (s.late) out.push({cls:'bad', title:`Encomenda ${o.number} · ${clientName(o) || 'sem cliente'}`, sub:`Prazo ultrapassado (${fmtDate(o.due)}) · ${s.done}/${s.total} unidades feitas`, href:'#encomendas'});
    else if (dl <= 2) out.push({cls:'warn', title:`Encomenda ${o.number} · ${clientName(o) || 'sem cliente'}`, sub:`Entrega ${dl === 0 ? 'hoje' : 'em ' + dl + ' dias úteis'} · ${s.done}/${s.total} unidades feitas`, href:'#encomendas'});
    if (s.toPlan) out.push({cls:'info', title:`Encomenda ${o.number}: ${s.toPlan} unidades por planear`, sub:`Prazo ${fmtDate(o.due)}`, href:'#producao'}); });
  S.quotes.filter(q => q.status === 'aceite' && !orderOf(q)).forEach(q => out.push({cls:'info', title:`Orçamento ${q.number} aceite`, sub:'Ainda não foi convertido em encomenda', href:'#encomendas'}));
  const lateLim = Date.now() - 30 * 60e3;
  S.plan.filter(p => p.status === 'planeada' && p.start && new Date(p.start) < lateLim).forEach(p => out.push({cls:'warn', title:`Impressão atrasada: ${p.desc}`, sub:`Devia ter começado ${fmtDT(p.start)} · ${(S.printers.find(x => x.id === p.printerId) || {}).name || ''}`, href:'#producao'}));
  const rank = {bad:0, warn:1, info:2};
  return out.sort((a, b) => rank[a.cls] - rank[b.cls]);
}

/* ---------- navegação ---------- */
const ICONS = {
  painel:'<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
  orcamentos:'<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h5"/>',
  bobines:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  manutencao:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  relatorios:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  encomendas:'<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10M7.5 5l9 4"/>',
  producao:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M7 13h5M7 17h9"/>',
  pecas:'<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  clientes:'<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-5.6"/>',
  definicoes:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'
};
const VIEWS = [['painel','Painel'],['orcamentos','Orçamentos'],['encomendas','Encomendas'],['producao','Produção'],['pecas','Peças'],['clientes','Clientes'],['bobines','Bobines'],['manutencao','Impressoras'],['relatorios','Relatórios'],['definicoes','Definições']];
const current = () => { const h = location.hash.slice(1); return VIEWS.some(v => v[0] === h) ? h : 'painel'; };

function renderNav(){
  const v = current(), a = loaded ? alerts() : [];
  const cnt = {bobines: a.filter(x => x.href === '#bobines').length, manutencao: a.filter(x => x.href === '#manutencao').length, encomendas: a.filter(x => x.href === '#encomendas' && x.cls !== 'info').length, producao: a.filter(x => x.href === '#producao').length};
  $('#nav').innerHTML = VIEWS.map(([k, l]) => `<a href="#${k}" ${k === v ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>${l}${cnt[k] ? `<span class="count">${cnt[k]}</span>` : ''}</a>`).join('');
  $('#brandName').textContent = settings().company || 'Oficina 3D';
  $('#storeNote').innerHTML = ME ? `<span class="who">${esc(ME.email)}</span><span class="conn ${online ? 'on' : 'off'}">${online ? 'Ligado' : 'Sem ligação'}</span><button type="button" class="linkbtn2" data-act="logout">Terminar sessão</button>` : '';
}

function render(){
  renderNav();
  if (!loaded){ $('#view').innerHTML = '<div class="loading">A carregar dados…</div>'; return; }
  const v = current();
  const html = ({painel:vPainel, orcamentos:vQuotes, encomendas:vOrders, producao:vProduction, pecas:vParts, clientes:vClients, bobines:vSpools, manutencao:vPrinters, relatorios:vReports, definicoes:vSettings})[v]();
  const banner = online ? '' : '<div class="banner">Sem ligação à internet. Está a ver os dados guardados neste aparelho; as alterações só são possíveis com ligação.</div>';
  $('#view').innerHTML = banner + html;
  if (v === 'definicoes') renderTeam();
}

/* ---------- vistas ---------- */
const st = {month: today().slice(0,7), repPrinter:'', spoolMat:'', spoolStatus:'', qStatus:'', partQ:'', partClient:'', clientQ:'', oFilter:'curso', gDays:3};

function kpiRow(s){
  return `<div class="kpis">
    <div class="kpi"><span class="label">Impressões</span><span class="val">${s.n}</span><span class="sub">${s.n - s.ok} falhada${s.n - s.ok === 1 ? '' : 's'}</span></div>
    <div class="kpi"><span class="label">Taxa de sucesso</span><span class="val">${s.n ? num(s.rate) + '%' : '—'}</span><span class="sub">${s.ok} concluídas</span></div>
    <div class="kpi"><span class="label">Tempo de impressão</span><span class="val">${hm(s.hours)}</span><span class="sub">horas de máquina</span></div>
    <div class="kpi"><span class="label">Filamento usado</span><span class="val">${num(s.grams / 1000, 2)} kg</span><span class="sub">${eur(s.matCost)} em material</span></div>
  </div>`;
}

function vPainel(){
  const m = today().slice(0, 7), s = stats(jobsIn(m)), a = alerts();
  const monthName = new Date(m + '-15').toLocaleDateString('pt-PT', {month:'long', year:'numeric'});
  const accepted = S.quotes.filter(q => q.status === 'aceite' && monthOf(q.date) === m).reduce((x, q) => x + calcQuote(q).total, 0);
  const recent = [...S.jobs].sort((x, y) => (y.date || '').localeCompare(x.date || '')).slice(0, 6);
  const noData = !S.spools.length && !S.printers.length && !S.jobs.length && !S.quotes.length;
  return `<div class="head"><div><div class="eyebrow">${esc(monthName)}</div><h1>Painel</h1><p>Orçamentos aceites este mês: <b class="num">${eur(accepted)}</b></p></div>
    <div class="actions"><button class="btn" data-act="new-job">Registar impressão</button><button class="btn primary" data-act="new-quote">Novo orçamento</button></div></div>
    ${noData ? `<div class="empty"><b>Ainda não há dados.</b><span>Comece por adicionar as suas impressoras e bobines; depois registe impressões e crie orçamentos.</span><div class="actions"><button class="btn" data-act="new-printer">Adicionar impressora</button><button class="btn" data-act="new-spool">Adicionar bobine</button><button class="btn ghost" data-act="sample">Carregar dados de exemplo</button></div></div>` : ''}
    ${kpiRow(s)}
    <div class="cols">
      <section class="panel"><div class="panel-h"><h2>Requer atenção</h2><span class="muted">${a.length} ${a.length === 1 ? 'item' : 'itens'}</span></div>
        ${a.length ? `<ul class="alerts">${a.map(x => `<li><span class="pill ${x.cls}">${x.cls === 'bad' ? 'Urgente' : x.cls === 'warn' ? 'Em breve' : 'Pendente'}</span><div class="txt">${esc(x.title)}<small>${esc(x.sub)}</small></div><a class="btn ghost sm" href="${x.href}">Ver</a></li>`).join('')}</ul>` : '<div class="empty">Tudo em dia: sem bobines em falta nem manutenções por fazer.</div>'}
      </section>
      <section class="panel"><div class="panel-h"><h2>Últimas impressões</h2><a class="btn ghost sm" href="#relatorios">Relatórios</a></div>
        ${recent.length ? `<ul class="alerts">${recent.map(j => `<li><span class="pill ${j.result === 'sucesso' ? 'ok' : 'bad'}">${j.result === 'sucesso' ? 'OK' : 'Falha'}</span><div class="txt">${esc(j.name)}<small>${fmtDate(j.date)} · ${hm(j.hours)} · ${num(j.grams)} g</small></div></li>`).join('')}</ul>` : '<div class="empty">Ainda não registou impressões.</div>'}
      </section>
    </div>`;
}

function vSpools(){
  const mats = [...new Set(S.spools.map(s => s.material))].sort();
  let list = S.spools.filter(s => (!st.spoolMat || s.material === st.spoolMat) && (!st.spoolStatus || spoolStatus(s)[1] === st.spoolStatus));
  list.sort((a, b) => spoolRemain(a) / (a.weight || 1) - spoolRemain(b) / (b.weight || 1));
  const stockKg = S.spools.reduce((a, s) => a + spoolRemain(s), 0) / 1000;
  const stockVal = S.spools.reduce((a, s) => a + spoolRemain(s) / 1000 * spoolEurKg(s), 0);
  const chip = (k, v, l) => `<button class="chip" data-act="filter" data-k="${k}" data-v="${esc(v)}" aria-pressed="${st[k] === v}">${esc(l)}</button>`;
  return `<div class="head"><div><div class="eyebrow">Controlo de filamento</div><h1>Bobines</h1><p><span class="num">${num(stockKg, 2)} kg</span> em stock · valor <span class="num">${eur(stockVal)}</span> · ${S.spools.length} bobines</p></div>
    <div class="actions"><button class="btn primary" data-act="new-spool">Nova bobine</button></div></div>
    <div class="chips">${chip('spoolMat', '', 'Todos os materiais')}${mats.map(m => chip('spoolMat', m, m)).join('')}
      <span style="width:12px"></span>${chip('spoolStatus', '', 'Todas')}${chip('spoolStatus', 'warn', 'Stock baixo')}${chip('spoolStatus', 'bad', 'Esgotadas')}</div>
    ${list.length ? `<div class="grid">${list.map(spoolCard).join('')}</div>` : `<div class="empty">${S.spools.length ? 'Nenhuma bobine com estes filtros.' : 'Ainda não registou bobines.'}<button class="btn" data-act="new-spool">Adicionar bobine</button></div>`}`;
}
function spoolCard(s){
  const pct = s.weight ? Math.min(1, spoolRemain(s) / s.weight) : 0, C = 2 * Math.PI * 30;
  const [t, c] = spoolStatus(s);
  return `<article class="spool ${c === 'bad' ? 'out' : ''}">
    <div class="spool-top">
      <div class="ring"><svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="30" fill="none" stroke="var(--sunk)" stroke-width="9"/><circle cx="36" cy="36" r="30" fill="none" stroke="${esc(s.hex || '#888')}" stroke-width="9" stroke-dasharray="${C * pct} ${C}"/><circle cx="36" cy="36" r="25.5" fill="none" stroke="var(--line)" stroke-width="1"/><circle cx="36" cy="36" r="34.5" fill="none" stroke="var(--line)" stroke-width="1"/></svg><span>${num(pct * 100)}%</span></div>
      <div class="spool-id"><b>${esc(spoolLabel(s))}</b><small>${esc(s.brand || 'Sem marca')}${s.diameter ? ' · ' + esc(s.diameter) + ' mm' : ''}</small><span class="pill ${c}">${t}</span></div>
    </div>
    <dl class="meta"><dt>Restante</dt><dd>${num(spoolRemain(s))} / ${num(s.weight)} g</dd><dt>Preço</dt><dd>${eur(s.price)} · ${eur(spoolEurKg(s))}/kg</dd><dt>Comprada</dt><dd>${fmtDate(s.bought)}</dd>${s.location ? `<dt>Local</dt><dd>${esc(s.location)}</dd>` : ''}</dl>
    <div class="card-foot"><button class="btn ghost sm" data-act="weigh" data-id="${s.id}">Pesar</button><button class="btn ghost sm" data-act="edit-spool" data-id="${s.id}">Editar</button><button class="btn ghost sm danger" data-act="del" data-col="spools" data-id="${s.id}">Eliminar</button></div>
  </article>`;
}

function vPrinters(){
  const hist = [...S.maint].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const yr = today().slice(0, 4), costYr = S.maint.filter(m => (m.date || '').startsWith(yr)).reduce((a, m) => a + (+m.cost || 0), 0);
  const pname = id => (S.printers.find(p => p.id === id) || {}).name || '—';
  return `<div class="head"><div><div class="eyebrow">Manutenção</div><h1>Impressoras</h1><p>${S.printers.length} impressoras · manutenção em ${yr}: <span class="num">${eur(costYr)}</span></p></div>
    <div class="actions"><button class="btn" data-act="new-maint">Registar manutenção</button><button class="btn primary" data-act="new-printer">Nova impressora</button></div></div>
    ${S.printers.length ? `<div class="printers">${S.printers.map(printerCard).join('')}</div>` : '<div class="empty">Ainda não registou impressoras.<button class="btn" data-act="new-printer">Adicionar impressora</button></div>'}
    <section class="panel"><div class="panel-h"><h2>Histórico de manutenção</h2></div>
    ${hist.length ? `<div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Impressora</th><th>Intervenção</th><th class="r">Horas</th><th class="r">Custo</th><th>Notas</th><th></th></tr></thead><tbody>
      ${hist.map(m => `<tr><td>${fmtDate(m.date)}</td><td>${esc(pname(m.printerId))}</td><td>${esc(m.task)}</td><td class="r num">${num(m.hoursAt)}</td><td class="r num">${eur(m.cost)}</td><td class="muted">${esc(m.notes)}</td><td class="r"><button class="btn ghost sm danger" data-act="del" data-col="maint" data-id="${m.id}">Eliminar</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Sem intervenções registadas.</div>'}</section>`;
}
function printerCard(p){
  const sCls = {ativa:'ok', manutencao:'warn', parada:'bad'}[p.status] || '';
  const sTxt = {ativa:'Ativa', manutencao:'Em manutenção', parada:'Parada'}[p.status] || p.status;
  return `<article class="printer">
    <div class="printer-h"><div><h3>${esc(p.name)}</h3><small>${esc(p.model || '')}${p.watts ? ' · ' + num(p.watts) + ' W' : ''}</small></div><span class="pill ${sCls}">${esc(sTxt)}</span></div>
    <div class="odo">${num(p.hours, 1)} <small>horas de impressão</small></div>
    <div class="tasks">${(p.tasks || []).map(t => { const s = taskState(p, t); return `<div class="task"><span class="nm">${esc(t.name)}</span><span class="hh">${num(Math.max(0, s.since))} / ${num(t.interval)} h</span><div class="bar"><i class="${s.cls}" style="width:${Math.min(100, Math.max(0, s.pct * 100))}%"></i></div></div>`; }).join('') || '<span class="muted">Sem plano de manutenção.</span>'}</div>
    <div class="card-foot"><button class="btn ghost sm" data-act="new-maint" data-id="${p.id}">Registar manutenção</button><button class="btn ghost sm" data-act="edit-printer" data-id="${p.id}">Editar</button><button class="btn ghost sm danger" data-act="del" data-col="printers" data-id="${p.id}">Eliminar</button></div>
  </article>`;
}

function vQuotes(){
  const list = S.quotes.filter(q => !st.qStatus || q.status === st.qStatus).sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const pend = S.quotes.filter(q => q.status === 'enviado').reduce((a, q) => a + calcQuote(q).total, 0);
  const chip = (v, l) => `<button class="chip" data-act="filter" data-k="qStatus" data-v="${v}" aria-pressed="${st.qStatus === v}">${l}</button>`;
  return `<div class="head"><div><div class="eyebrow">Vendas</div><h1>Orçamentos</h1><p>A aguardar resposta: <span class="num">${eur(pend)}</span></p></div>
    <div class="actions"><button class="btn primary" data-act="new-quote">Novo orçamento</button></div></div>
    <div class="chips">${chip('', 'Todos')}${Object.entries(QSTATUS).map(([k, [l]]) => chip(k, l)).join('')}</div>
    ${list.length ? `<div class="tbl-wrap"><table><thead><tr><th>Nº</th><th>Cliente</th><th>Data</th><th>Peças</th><th class="r">Filamento</th><th class="r">Tempo</th><th class="r">Total</th><th>Estado</th><th>Encomenda</th></tr></thead><tbody>
      ${list.map(q => { const c = calcQuote(q), [l, cls] = QSTATUS[q.status] || ['—', '']; return `<tr class="click" data-act="edit-quote" data-id="${q.id}" tabindex="0"><td class="num">${esc(q.number)}</td><td>${esc(clientName(q) || '—')}</td><td>${fmtDate(q.date)}</td><td class="muted">${esc((q.items || []).map(i => i.desc).filter(Boolean).join(', ') || '—')}</td><td class="r num">${num(c.grams)} g</td><td class="r num">${hm(c.hours)}</td><td class="r num"><b>${eur(c.total)}</b></td><td><span class="pill ${cls}">${l}</span></td><td style="white-space:nowrap">${downloads ? `<button class="btn ghost sm" data-act="quote-pdf-id" data-id="${q.id}">PDF</button>` : ''}${orderOf(q) ? `<span class="mono">${esc(orderOf(q).number)}</span>` : q.status === 'aceite' ? `<button class="btn sm" data-act="convert" data-id="${q.id}">Converter</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty">${S.quotes.length ? 'Nenhum orçamento com este estado.' : 'Ainda não criou orçamentos.'}<button class="btn" data-act="new-quote">Criar orçamento</button></div>`}`;
}

function vReports(){
  const jobs = jobsIn(st.month, st.repPrinter).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const s = stats(jobs);
  const byMat = {}; jobs.forEach(j => usesOf(j).forEach(u => { const sp = S.spools.find(x => x.id === u.spoolId); const m = sp ? sp.material : 'Outro'; byMat[m] = (byMat[m] || 0) + u.grams; }));
  const byPr = {}; jobs.forEach(j => { const p = S.printers.find(x => x.id === j.printerId); const n = p ? p.name : '—'; byPr[n] = (byPr[n] || 0) + (+j.hours || 0); });
  const bars = (obj, fmt, color) => { const e = Object.entries(obj).sort((a, b) => b[1] - a[1]), mx = Math.max(1, ...e.map(x => x[1])); return e.length ? `<div class="hbars">${e.map(([k, v]) => `<div class="hb"><span>${esc(k)}</span><div class="track"><i style="width:${v / mx * 100}%;${color ? `background:${color(k)}` : ''}"></i></div><span class="v">${fmt(v)}</span></div>`).join('')}</div>` : '<div class="empty">Sem dados neste período.</div>'; };
  const pn = id => (S.printers.find(p => p.id === id) || {}).name || '—';
  const sn = id => { const sp = S.spools.find(x => x.id === id); return sp ? spoolLabel(sp) : '—'; };
  return `<div class="head"><div><div class="eyebrow">Produção</div><h1>Relatórios de impressão</h1><p>${s.wasted ? `Filamento perdido em falhas: <span class="num">${num(s.wasted)} g</span>` : 'Sem filamento perdido em falhas neste período.'}</p></div>
    <div class="actions">${downloads ? '<button class="btn" data-act="csv">Exportar CSV</button>' : ''}<button class="btn primary" data-act="new-job">Registar impressão</button></div></div>
    <div class="filters"><div class="field"><label for="f-month">Mês</label><input type="month" id="f-month" value="${st.month}"></div>
      <div class="field"><label for="f-printer">Impressora</label><select id="f-printer"><option value="">Todas</option>${S.printers.map(p => `<option value="${p.id}" ${st.repPrinter === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div></div>
    ${kpiRow(s)}
    <div class="cols">
      <section class="panel"><h2>Filamento por material</h2>${bars(byMat, v => num(v) + ' g', k => MAT_COLORS[k] || MAT_COLORS.Outro)}</section>
      <section class="panel"><h2>Horas por impressora</h2>${bars(byPr, v => hm(v))}</section>
    </div>
    ${jobs.length ? `<div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Peça</th><th>Cliente</th><th>Impressora</th><th>Filamento</th><th class="r">Gramas</th><th class="r">Tempo</th><th>Resultado</th><th></th></tr></thead><tbody>
      ${jobs.map(j => `<tr><td>${fmtDate(j.date)}</td><td>${esc(j.name)}${j.notes ? `<br><small class="muted">${esc(j.notes)}</small>` : ''}</td><td>${esc(clientName(j) || '—')}</td><td>${esc(pn(j.printerId))}</td><td>${usesOf(j).map(u => `<span class="usel">${swatch(spoolHex(u.spoolId))}${esc(sn(u.spoolId) || 'Sem bobine')}${usesOf(j).length > 1 ? ` <small class="muted num">${num(u.grams)} g</small>` : ''}</span>`).join('') || '—'}</td><td class="r num">${num(sumG(usesOf(j)))}</td><td class="r num">${hm(j.hours)}</td><td><span class="pill ${j.result === 'sucesso' ? 'ok' : 'bad'}">${j.result === 'sucesso' ? 'Sucesso' : 'Falha'}</span>${j.result === 'falha' && j.reason ? `<br><small class="muted">${esc(j.reason)}</small>` : ''}</td><td class="r" style="white-space:nowrap"><button class="btn ghost sm" data-act="edit-job" data-id="${j.id}">Editar</button><button class="btn ghost sm danger" data-act="del" data-col="jobs" data-id="${j.id}">Eliminar</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Sem impressões registadas neste período.<button class="btn" data-act="new-job">Registar impressão</button></div>'}`;
}

function vSettings(){
  const s = settings();
  return `<div class="head"><div><div class="eyebrow">Configuração</div><h1>Definições</h1><p>Estes valores entram no cálculo de todos os orçamentos.</p></div></div>
  <form class="panel" id="settings-form">
    <h2>Empresa e custos</h2>
    <div class="row">
      <div class="field"><label for="s-company">Nome da empresa</label><input id="s-company" value="${esc(s.company)}"></div>
      <div class="field"><label for="s-kwh">Eletricidade (€/kWh)</label><input id="s-kwh" type="number" step="0.001" min="0" value="${s.kwh}"></div>
      <div class="field"><label for="s-labor">Mão de obra (€/hora)</label><input id="s-labor" type="number" step="0.5" min="0" value="${s.labor}"></div>
    </div>
    <div class="row">
      <div class="field"><label for="s-margin">Margem de lucro por defeito (%)</label><input id="s-margin" type="number" step="1" min="0" value="${s.margin}"></div>
      <div class="field"><label for="s-failure">Margem para falhas (%)</label><input id="s-failure" type="number" step="1" min="0" value="${s.failure}"><span class="hint">Aplicada a material, energia e desgaste.</span></div>
      <div class="field"><label for="s-vat">IVA (%)</label><input id="s-vat" type="number" step="1" min="0" value="${s.vat}"></div>
      <div class="field"><label for="s-low">Alerta de stock baixo (g)</label><input id="s-low" type="number" step="10" min="0" value="${s.low}"></div>
      <div class="field"><label for="s-delivery">Prazo de entrega por defeito (dias úteis)</label><input id="s-delivery" type="number" step="1" min="0" value="${s.delivery}"></div>
    </div>
    <h2>Preço de referência dos materiais (€/kg)</h2>
    <p class="muted" style="margin:0">Usado nos orçamentos quando escolhe um material genérico em vez de uma bobine específica.</p>
    <div class="row">${Object.entries(s.matPrices).map(([k, v]) => `<div class="field"><label for="mp-${k}">${k}</label><input id="mp-${k}" data-mat="${k}" type="number" step="0.5" min="0" value="${v}"></div>`).join('')}</div>
    <h2>Dados da empresa no PDF do orçamento</h2>
    <div class="row">
      <div class="field"><label for="s-nif">NIF</label><input id="s-nif" value="${esc(s.cNif)}"></div>
      <div class="field"><label for="s-phone">Telefone</label><input id="s-phone" type="tel" value="${esc(s.cPhone)}"></div>
      <div class="field"><label for="s-email">Email</label><input id="s-email" type="email" value="${esc(s.cEmail)}"></div>
      <div class="field"><label for="s-web">Website</label><input id="s-web" value="${esc(s.cWeb)}"></div>
    </div>
    <div class="row">
      <div class="field"><label for="s-address">Morada</label><textarea id="s-address">${esc(s.cAddress)}</textarea></div>
      <div class="field"><label for="s-iban">IBAN (opcional)</label><input id="s-iban" value="${esc(s.cIban)}"><span class="hint">Aparece nas condições de pagamento.</span></div>
    </div>
    <div class="row">
      <div class="field"><label>Logótipo</label><div class="logo-box"><div class="logo-prev" id="s-logo-prev">${(st.logo !== undefined ? st.logo : s.logo) ? `<img src="${esc(st.logo !== undefined ? st.logo : s.logo)}" alt="Logótipo">` : '<span class="muted">Sem logótipo</span>'}</div>
        <label class="btn sm file-btn">Escolher imagem<input type="file" id="s-logo" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label>${(st.logo !== undefined ? st.logo : s.logo) ? '<button type="button" class="btn ghost sm" data-act="logo-rm">Remover</button>' : ''}</div><span class="hint">PNG com fundo transparente fica melhor.</span></div>
      <div class="field"><label for="s-color">Cor do documento</label><input id="s-color" type="color" value="${esc(s.pdfColor)}" style="height:40px;padding:4px"></div>
    </div>
    <div class="field"><label for="s-cond">Condições (aparecem no fim do orçamento)</label><textarea id="s-cond" style="min-height:90px">${esc(s.cond)}</textarea></div>
    <div class="actions"><button class="btn primary" type="submit">Guardar definições</button></div>
  </form>
  <section class="panel"><div class="panel-h"><h2>Equipa</h2></div><p class="muted" style="margin:0">Todas as pessoas da equipa veem e alteram os mesmos dados, em qualquer aparelho.</p><div id="team"><p class="muted">A carregar…</p></div></section>
  <section class="panel"><div class="panel-h"><h2>Conta</h2></div><p style="margin:0">Sessão iniciada como <b>${esc(ME ? ME.email : '')}</b>.</p><div class="actions"><button type="button" class="btn" data-act="logout">Terminar sessão</button></div></section>`;
}

function vParts(){
  const q = st.partQ.trim().toLowerCase();
  const list = S.parts.filter(p => (!st.partClient || (st.partClient === '__geral' ? !p.clientId : p.clientId === st.partClient)) && (!q || `${p.name} ${p.ref} ${clientName(p)}`.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
  return `<div class="head"><div><div class="eyebrow">Catálogo</div><h1>Peças</h1><p>${S.parts.length} peças guardadas. Os orçamentos são montados a partir daqui.</p></div>
    <div class="actions"><button class="btn" data-act="import-parts">Importar G-code</button><button class="btn primary" data-act="new-part">Nova peça</button></div></div>
    <div class="filters"><div class="field" style="flex:1;min-width:200px"><label for="f-part-q">Procurar</label><input id="f-part-q" type="search" value="${esc(st.partQ)}" placeholder="Nome, referência ou cliente"></div>
      <div class="field"><label for="f-part-client">Cliente</label>${sel('f-part-client', [['', 'Todos'], ['__geral', 'Gerais (sem cliente)']].concat(clientOpts()), st.partClient)}</div></div>
    ${list.length ? `<div class="tbl-wrap"><table><thead><tr><th></th><th>Peça</th><th>Cliente</th><th>Material</th><th class="r">Filamento</th><th class="r">Impressão</th><th class="r">Mão de obra</th><th class="r">Preço ref.</th><th></th></tr></thead><tbody>
      ${list.map(p => `<tr class="click" data-act="edit-part" data-id="${p.id}" tabindex="0"><td style="width:52px">${thumbImg(p.thumb)}</td><td><b>${esc(p.name)}</b>${p.ref ? `<br><small class="muted mono">${esc(p.ref)}</small>` : ''}</td><td>${esc(clientName(p) || 'Geral')}</td><td>${filsOf(p).length > 1 ? `<span class="sws">${filsOf(p).map(f => swatch(matHex(f.mat) || f.hex)).join('')}</span>` : ''}${esc(filsTypes(p) || '—')}${filsOf(p).length > 1 ? ` <small class="muted">(${filsOf(p).length} filamentos)</small>` : ''}</td><td class="r num">${num(sumG(filsOf(p)), 1)} g</td><td class="r num">${hm(p.hours)}</td><td class="r num">${p.laborH ? num(p.laborH * 60) + ' min' : '—'}</td><td class="r num">${eur(partPrice(p))}</td>
        <td class="r" style="white-space:nowrap"><button class="btn ghost sm" data-act="quote-part" data-id="${p.id}">Orçamentar</button><button class="btn ghost sm danger" data-act="del" data-col="parts" data-id="${p.id}">Eliminar</button></td></tr>`).join('')}
    </tbody></table></div><p class="muted" style="margin:0;font-size:.82rem">Preço de referência por unidade, sem IVA, com as margens das Definições e a primeira impressora. No orçamento pode ajustar tudo.</p>`
    : `<div class="empty">${S.parts.length ? 'Nenhuma peça corresponde à pesquisa.' : 'Ainda não tem peças no catálogo. Crie uma à mão ou importe ficheiros G-code.'}<div class="actions"><button class="btn" data-act="import-parts">Importar G-code</button><button class="btn" data-act="new-part">Nova peça</button></div></div>`}`;
}
function vClients(){
  const q = st.clientQ.trim().toLowerCase();
  const list = S.clients.filter(c => !q || `${c.name} ${c.nif} ${c.email} ${c.phone}`.toLowerCase().includes(q)).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt'));
  const info = c => { const qs = S.quotes.filter(x => x.clientId === c.id); return {n:qs.length, acc:qs.filter(x => x.status === 'aceite').reduce((a, x) => a + calcQuote(x).total, 0), parts:S.parts.filter(p => p.clientId === c.id).length}; };
  return `<div class="head"><div><div class="eyebrow">Base de dados</div><h1>Clientes</h1><p>${S.clients.length} clientes</p></div>
    <div class="actions"><button class="btn primary" data-act="new-client">Novo cliente</button></div></div>
    <div class="filters"><div class="field" style="flex:1;min-width:200px"><label for="f-client-q">Procurar</label><input id="f-client-q" type="search" value="${esc(st.clientQ)}" placeholder="Nome, NIF, email ou telefone"></div></div>
    ${list.length ? `<div class="tbl-wrap"><table><thead><tr><th>Cliente</th><th>NIF</th><th>Contacto</th><th class="r">Peças</th><th class="r">Orçamentos</th><th class="r">Aceite (total)</th><th></th></tr></thead><tbody>
      ${list.map(c => { const i = info(c); return `<tr class="click" data-act="edit-client" data-id="${c.id}" tabindex="0"><td><b>${esc(c.name)}</b></td><td class="mono">${esc(c.nif || '—')}</td><td>${esc(c.email || '')}${c.email && c.phone ? '<br>' : ''}${esc(c.phone || '')}${!c.email && !c.phone ? '—' : ''}</td><td class="r num">${i.parts}</td><td class="r num">${i.n}</td><td class="r num">${eur(i.acc)}</td>
        <td class="r" style="white-space:nowrap"><button class="btn ghost sm" data-act="quote-client" data-id="${c.id}">Novo orçamento</button><button class="btn ghost sm danger" data-act="del" data-col="clients" data-id="${c.id}">Eliminar</button></td></tr>`; }).join('')}
    </tbody></table></div>`
    : `<div class="empty">${S.clients.length ? 'Nenhum cliente corresponde à pesquisa.' : 'Ainda não registou clientes.'}<button class="btn" data-act="new-client">Adicionar cliente</button></div>`}`;
}

/* ---------- encomendas e produção ---------- */
const OSTATUS = {pendente:['Por planear','warn'], planeada:['Planeada','info'], em_producao:['Em produção','info'], pronta:['Pronta','ok'], entregue:['Entregue',''], cancelada:['Cancelada','bad']};
const PSTATUS = {planeada:['Planeada','info'], a_imprimir:['A imprimir','warn'], concluida:['Concluída','ok'], falhada:['Falhada','bad']};
const ymd = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const localDT = x => `${ymd(x)}T${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
const roundUp15 = d => { const x = new Date(d); x.setSeconds(0, 0); const m = x.getMinutes(); if (m % 15) x.setMinutes(m + 15 - m % 15); return x; };
const fmtDT = s => s ? new Date(s).toLocaleString('pt-PT', {weekday:'short', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : '—';
const fmtT = d => d.toLocaleTimeString('pt-PT', {hour:'2-digit', minute:'2-digit'});
function addBusinessDays(d, n){ const x = new Date(d + 'T12:00'); let k = 0; while (k < n){ x.setDate(x.getDate() + 1); const w = x.getDay(); if (w !== 0 && w !== 6) k++; } return ymd(x); }
function businessDaysBetween(a, b){ if (!a || !b || b <= a) return 0; const x = new Date(a + 'T12:00'), e = new Date(b + 'T12:00'); let n = 0; while (x < e){ x.setDate(x.getDate() + 1); const w = x.getDay(); if (w !== 0 && w !== 6) n++; } return n; }
const planEnd = p => new Date(new Date(p.start).getTime() + (+p.hours || 0) * 3600e3);
const activePlan = p => p.status === 'planeada' || p.status === 'a_imprimir';
function nextFree(printerId, from){
  let t = from ? new Date(from) : new Date(); const now = new Date(); if (t < now) t = now;
  S.plan.filter(p => p.printerId === printerId && activePlan(p)).forEach(p => { const e = planEnd(p); if (e > t) t = e; });
  return roundUp15(t);
}
function nextNumber(list, prefix){
  const y = today().slice(0, 4), n = list.filter(x => (x.number || '').startsWith(`${prefix}-${y}-`)).map(x => +x.number.split('-')[2] || 0);
  return `${prefix}-${y}-${String((n.length ? Math.max(...n) : 0) + 1).padStart(3, '0')}`;
}
function orderState(o){
  const items = (o.items || []).map(it => {
    const done = S.jobs.filter(j => j.orderId === o.id && j.itemId === it.id && j.result === 'sucesso').reduce((a, j) => a + (+j.qty || 1), 0);
    const pl = S.plan.filter(p => p.orderId === o.id && p.itemId === it.id && activePlan(p));
    const planned = pl.reduce((a, p) => a + (+p.qty || 0), 0);
    return {...it, done, planned, printing:pl.some(p => p.status === 'a_imprimir'), toPlan:Math.max(0, (+it.qty || 0) - done - planned)};
  });
  const sum = k => items.reduce((a, i) => a + i[k], 0);
  const total = items.reduce((a, i) => a + (+i.qty || 0), 0), done = items.reduce((a, i) => a + Math.min(i.done, +i.qty || 0), 0);
  const planned = sum('planned'), toPlan = sum('toPlan');
  const status = o.closed || (total && done >= total ? 'pronta' : (done > 0 || items.some(i => i.printing)) ? 'em_producao' : planned > 0 ? 'planeada' : 'pendente');
  const open = !['pronta', 'entregue', 'cancelada'].includes(status);
  return {items, total, done, planned, toPlan, status, open, late: open && o.due && o.due < today(), pct: total ? done / total : 0};
}
const orderOf = q => S.orders.find(o => o.quoteId === q.id);

async function convertQuote(q){
  const ex = orderOf(q); if (ex){ orderForm(ex); return; }
  if (!(q.items || []).length){ toast('O orçamento não tem peças.'); return; }
  const c = calcQuote(q);
  const o = {id:uid(), number:nextNumber(S.orders, 'ENC'), quoteId:q.id, quoteNumber:q.number, clientId:q.clientId || '', client:clientName(q), date:today(),
    due: addBusinessDays(today(), +q.deliveryDays || 0), closed:'', notes:q.notes || '', total:c.total, net:c.net, printerId:q.printerId || '',
    items:(q.items || []).map(it => withFils({id:it.id, partId:it.partId || '', desc:it.desc, ref:it.ref || '', hours:+it.hours || 0, qty:+it.qty || 1, thumb:it.thumb || ''}, filsOf(it)))};
  if (JSON.stringify(o).length > 200000) o.items.forEach(it => { it.thumb = ''; });
  if (q.status !== 'aceite') await put('quotes', {...q, status:'aceite'});
  await put('orders', o);
  toast(`Encomenda ${o.number} criada.`);
  S.orders.some(x => x.id === o.id) || S.orders.push(o);
  orderForm(o);
}

function orderForm(o){
  o = cp(o); const stt = orderState(o);
  const jobs = S.jobs.filter(j => j.orderId === o.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const [sl, sc] = OSTATUS[stt.status];
  openDlg(`Encomenda ${o.number}`, `
    <div class="ostrip"><div><span class="eyebrow">Cliente</span><b>${esc(clientName(o) || '—')}</b></div><div><span class="eyebrow">Orçamento</span><b class="mono">${esc(o.quoteNumber || '—')}</b></div><div><span class="eyebrow">Total</span><b class="num">${eur(o.total)}</b></div><div><span class="eyebrow">Estado</span><span class="pill ${sc}">${sl}</span>${stt.late ? ' <span class="pill bad">Atrasada</span>' : ''}</div></div>
    <div class="row">${F('o-date', 'Data da encomenda', inp('o-date', o.date, 'date'))}${F('o-due', 'Prazo de entrega', inp('o-due', o.due, 'date'))}${F('o-closed', 'Estado', sel('o-closed', [['', 'Automático (pela produção)'], ['entregue', 'Entregue ao cliente'], ['cancelada', 'Cancelada']], o.closed || ''))}</div>
    <div class="tbl-wrap"><table><thead><tr><th></th><th>Peça</th><th class="r">Qtd.</th><th class="r">Feitas</th><th class="r">Planeadas</th><th class="r">Por planear</th><th style="width:120px">Progresso</th></tr></thead><tbody>
      ${stt.items.map(i => `<tr><td style="width:48px">${thumbImg(i.thumb, 36)}</td><td>${esc(i.desc)}${i.ref ? ` <small class="muted mono">${esc(i.ref)}</small>` : ''}<br><small class="muted">${filsOf(i).length > 1 ? filsOf(i).map(f => swatch(matHex(f.mat) || f.hex)).join('') + ' ' : ''}${esc(filsText(i))}</small></td><td class="r num">${i.qty}</td><td class="r num">${i.done}</td><td class="r num">${i.planned}</td><td class="r num">${i.toPlan ? `<b>${i.toPlan}</b>` : '0'}</td><td><div class="bar"><i class="${i.done >= i.qty ? '' : 'info'}" style="width:${Math.min(100, i.done / (i.qty || 1) * 100)}%"></i></div></td></tr>`).join('')}
    </tbody></table></div>
    ${F('o-notes', 'Notas', `<textarea id="o-notes">${esc(o.notes)}</textarea>`)}
    ${jobs.length ? `<h3>Impressões registadas</h3><ul class="alerts">${jobs.map(j => `<li><span class="pill ${j.result === 'sucesso' ? 'ok' : 'bad'}">${j.result === 'sucesso' ? 'OK' : 'Falha'}</span><div class="txt">${esc(j.name)}<small>${fmtDate(j.date)} · ${j.qty || 1} un. · ${hm(j.hours)} · ${num(j.grams)} g</small></div></li>`).join('')}</ul>` : ''}`,
  {wide:true, extra:`<div class="actions"><button type="button" class="btn danger" data-act="del" data-col="orders" data-id="${o.id}">Eliminar</button>${stt.toPlan && stt.open ? `<button type="button" class="btn" data-act="plan-order" data-id="${o.id}">Planear produção</button>` : ''}</div>`,
   handler: async () => {
    Object.assign(o, {date:val('o-date'), due:val('o-due'), closed:val('o-closed'), notes:val('o-notes').trim()});
    await put('orders', o); closeDlg(); toast('Encomenda guardada.');
  }});
  orderForm.save = async () => { Object.assign(o, {date:val('o-date'), due:val('o-due'), closed:val('o-closed'), notes:val('o-notes').trim()}); await put('orders', o); return o; };
}

function spoolOptsFor(mat, need){
  const type = matType(mat);
  const list = S.spools.filter(s => spoolRemain(s) > 0).sort((a, b) => (b.material === type) - (a.material === type) || spoolRemain(b) - spoolRemain(a));
  return [['', 'Decidir na altura']].concat(list.map(s => ['' + s.id, `${spoolLabel(s)} — ${num(spoolRemain(s))} g${need && spoolRemain(s) < need ? ' (insuficiente)' : ''}`]));
}
function defaultSpool(mat, need, hex){
  if (mat && mat.startsWith('s:') && S.spools.some(s => s.id === mat.slice(2))) return mat.slice(2);
  const s = bestSpool(matType(mat), hex, need);
  return s && spoolRemain(s) >= need ? s.id : '';
}
const activePrinters = () => S.printers.filter(p => p.status !== 'parada');

function planOrderDlg(o){
  const stt = orderState(o), items = stt.items.filter(i => i.toPlan > 0);
  if (!items.length){ toast('Esta encomenda já está toda planeada.'); return; }
  if (!activePrinters().length){ toast('Não há impressoras ativas. Adicione ou ative uma impressora.'); return; }
  const pOpts = [['auto', 'Distribuir pelas impressoras livres']].concat(activePrinters().map(p => [p.id, p.name]));
  openDlg(`Planear ${o.number}`, `
    <p style="margin:0">${esc(clientName(o) || 'Sem cliente')} · prazo <b>${fmtDate(o.due)}</b>. Indique quantas unidades cabem em cada impressão (placa): são criadas as impressões necessárias e colocadas na fila de cada impressora.</p>
    <div class="row">${F('pl-start', 'Começar a partir de', inp('pl-start', localDT(roundUp15(new Date())), 'datetime-local'))}</div>
    <div class="items">${items.map(i => `<div class="plrow" data-id="${i.id}">
      <div class="qi-name">${thumbImg(i.thumb)}<div><b>${esc(i.desc)}</b><small>${i.toPlan} un. por planear · ${filsOf(i).length > 1 ? filsOf(i).length + ' filamentos · ' : ''}${num(sumG(filsOf(i)), 1)} g · ${hm(i.hours)} por unidade</small></div></div>
      ${F('pl-per-' + i.id, 'Unid. por impressão', inp('pl-per-' + i.id, Math.min(i.toPlan, Math.max(1, Math.floor(8 / Math.max(i.hours, .1)))), 'number', `min="1" max="${i.toPlan}" step="1"`))}
      ${F('pl-pr-' + i.id, 'Impressora', sel('pl-pr-' + i.id, pOpts, o.printerId && activePrinters().some(p => p.id === o.printerId) && items.length === 1 ? o.printerId : 'auto'))}
      <div class="field pl-fils${filsOf(i).length > 1 ? ' multi' : ''}"><label>${filsOf(i).length > 1 ? 'Bobines' : 'Bobine'}</label>${filsOf(i).map((f, k) => `<div class="qf">${swatch(matHex(f.mat) || f.hex)}${sel(`pl-sp-${i.id}-${k}`, spoolOptsFor(f.mat, f.grams * i.toPlan), defaultSpool(f.mat, f.grams * i.toPlan, f.hex))}${filsOf(i).length > 1 ? `<span class="num muted">${num(f.grams, 1)} g/un.</span>` : ''}</div>`).join('')}</div>
    </div>`).join('')}</div>
    <div class="sum" id="pl-out"></div>`,
  {wide:true, submit:'Criar planeamento',
   input: () => {
    const e = buildPlan(o, items);
    const last = e.reduce((m, x) => { const t = planEnd(x); return t > m ? t : m; }, new Date(0));
    const lateBy = o.due && ymd(last) > o.due;
    $('#pl-out').innerHTML = `<div class="l"><span>Impressões a criar</span><span>${e.length}</span></div><div class="l"><span>Tempo total de máquina</span><span>${hm(e.reduce((a, x) => a + x.hours, 0))}</span></div><div class="l"><span>Conclusão prevista</span><span>${e.length ? fmtDT(localDT(last)) : '—'}</span></div>${lateBy ? '<div class="l neg"><span>Termina depois do prazo de entrega</span><span></span></div>' : ''}`;
   },
   handler: async () => {
    const e = buildPlan(o, items);
    for (const x of e) await put('plan', x);
    closeDlg(); toast(`${e.length} impressões planeadas.`); location.hash = '#producao';
  }});
}
function buildPlan(o, items){
  const start = val('pl-start') ? new Date(val('pl-start')) : new Date();
  const free = {}; activePrinters().forEach(p => free[p.id] = nextFree(p.id, start));
  const out = [];
  items.forEach(i => {
    const per = Math.max(1, Math.round(numv('pl-per-' + i.id))), fixed = val('pl-pr-' + i.id);
    const spools = filsOf(i).map((f, k) => val(`pl-sp-${i.id}-${k}`));
    let left = i.toPlan;
    while (left > 0){
      const q = Math.min(per, left);
      const pid = fixed !== 'auto' && free[fixed] ? fixed : Object.keys(free).sort((a, b) => free[a] - free[b])[0];
      const fl = filsOf(i).map((f, k) => ({mat:f.mat, hex:f.hex, grams:r2(f.grams * q), spoolId:spools[k] || ''}));
      const e = withFils({id:uid(), orderId:o.id, orderNumber:o.number, itemId:i.id, partId:i.partId || '', desc:i.desc, thumb:'', printerId:pid,
        qty:q, hours:r2(i.hours * q), start:localDT(free[pid]), status:'planeada', notes:''}, fl);
      e.spoolId = fl[0] ? fl[0].spoolId : '';
      free[pid] = roundUp15(planEnd(e)); out.push(e); left -= q;
    }
  });
  return out;
}

function planForm(p){
  const isNew = !p;
  if (!S.printers.length){ toast('Adicione primeiro uma impressora.'); return; }
  p = p ? cp(p) : (() => { const pid = (activePrinters()[0] || S.printers[0]).id; return {id:uid(), orderId:'', orderNumber:'', itemId:'', partId:'', desc:'', printerId:pid, spoolId:'', mat:'', qty:1, grams:0, hours:0, start:localDT(nextFree(pid)), status:'planeada', notes:''}; })();
  const ord = p.orderId && S.orders.find(o => o.id === p.orderId);
  let lastPart = p.partId;
  openDlg(isNew ? 'Nova impressão planeada' : 'Impressão planeada', `
    ${ord ? `<p style="margin:0">Encomenda <b class="mono">${esc(ord.number)}</b> · ${esc(clientName(ord) || 'sem cliente')} · prazo ${fmtDate(ord.due)}</p>` : `<div class="row">${F('pf-part', 'Peça do catálogo', `<select id="pf-part"><option value="">— Escolher —</option>${[...S.parts].sort((a, b) => a.name.localeCompare(b.name, 'pt')).map(x => `<option value="${x.id}" ${x.id === p.partId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`)}</div>`}
    <div class="row">${F('pf-desc', 'Descrição', inp('pf-desc', p.desc))}${F('pf-qty', 'Unidades', inp('pf-qty', p.qty, 'number', 'min="1" step="1"'))}${F('pf-status', 'Estado', sel('pf-status', Object.entries(PSTATUS).map(([k, [l]]) => [k, l]), p.status))}</div>
    <div class="row">${F('pf-printer', 'Impressora', sel('pf-printer', S.printers.map(x => [x.id, x.name + (x.status === 'parada' ? ' (parada)' : '')]), p.printerId))}${F('pf-start', 'Início', inp('pf-start', p.start, 'datetime-local'))}</div>
    <div class="row">${hmInputs('pf', p.hours, 'Duração')}</div>
    <div class="field"><label>Filamentos desta impressão (até ${MAXF})</label>${filEditor('pf', filsOf(p), 'spool')}</div>
    ${F('pf-notes', 'Notas', `<textarea id="pf-notes">${esc(p.notes)}</textarea>`)}
    <p class="muted" id="pf-end" style="margin:0"></p>`,
  {extra: isNew ? '' : `<div class="actions"><button type="button" class="btn danger" data-act="del" data-col="plan" data-id="${p.id}">Eliminar</button></div>`,
   input: () => {
    const pid = val('pf-part');
    if (pid && pid !== lastPart){ const x = S.parts.find(y => y.id === pid); if (x){ const q = Math.max(1, numv('pf-qty')); $('#pf-desc').value = x.name; setHM('pf', x.hours * q); setFils('pf', filsToSpools(filsOf(x), q)); } }
    filsUpdated('pf');
    lastPart = pid;
    const st0 = val('pf-start'); $('#pf-end').textContent = st0 ? `Termina: ${fmtDT(localDT(new Date(new Date(st0).getTime() + readHM('pf') * 3600e3)))}` : '';
   },
   handler: async () => {
    if (!val('pf-desc').trim()){ toast('Indique a descrição.'); return; }
    if (!val('pf-start')){ toast('Indique o início.'); return; }
    Object.assign(p, {desc:val('pf-desc').trim(), qty:Math.max(1, Math.round(numv('pf-qty'))), status:val('pf-status'), printerId:val('pf-printer'), start:val('pf-start'), hours:readHM('pf'), notes:val('pf-notes').trim()}, withFils({}, readFils('pf')));
    p.spoolId = (p.fils[0] || {}).spoolId || '';
    if (!ord && val('pf-part')) p.partId = val('pf-part');
    await put('plan', p); closeDlg(); toast('Planeamento guardado.');
  }});
}
async function startPlan(p){
  const c = cp(p); c.status = 'a_imprimir'; const now = new Date(); now.setSeconds(0, 0); c.start = localDT(now);
  await put('plan', c); await pushQueue(c.printerId, c);
  toast(`${c.desc} a imprimir.`);
}
// empurra para a frente as impressões planeadas que ficariam sobrepostas
async function pushQueue(printerId, changed){
  const list = S.plan.filter(x => x.printerId === printerId && activePlan(x)).map(x => x.id === changed.id ? changed : x).sort((a, b) => a.start.localeCompare(b.start));
  if (!list.some(x => x.id === changed.id)) list.push(changed);
  list.sort((a, b) => (a.status === 'a_imprimir' ? 0 : 1) - (b.status === 'a_imprimir' ? 0 : 1) || a.start.localeCompare(b.start));
  let t = null;
  for (const x of list){
    if (t && new Date(x.start) < t && x.status === 'planeada' && x.id !== changed.id){ const c = cp(x); c.start = localDT(roundUp15(t)); await put('plan', c); t = planEnd(c); }
    else { const e = planEnd(x); t = !t || e > t ? e : t; }
  }
}
async function compactQueue(printerId){
  const list = S.plan.filter(x => x.printerId === printerId && activePlan(x));
  const running = list.filter(x => x.status === 'a_imprimir');
  let t = roundUp15(running.reduce((m, x) => { const e = planEnd(x); return e > m ? e : m; }, new Date()));
  let n = 0;
  for (const x of list.filter(x => x.status === 'planeada').sort((a, b) => a.start.localeCompare(b.start))){
    const s = localDT(t); if (s !== x.start){ const c = cp(x); c.start = s; await put('plan', c); n++; }
    t = roundUp15(planEnd({...x, start:s}));
  }
  toast(n ? `Fila reorganizada (${n} ${n === 1 ? 'impressão' : 'impressões'}).` : 'A fila já está seguida.');
}
function finishPlan(p){
  const ord = p.orderId && S.orders.find(o => o.id === p.orderId);
  const uses = filsOf(p).map(f => ({spoolId:f.spoolId && S.spools.some(s => s.id === f.spoolId) ? f.spoolId : defaultSpool(f.mat, f.grams, f.hex), grams:f.grams}));
  jobForm(null, {name:p.desc + (p.qty > 1 ? ` ×${p.qty}` : ''), partId:p.partId || '', qty:p.qty, printerId:p.printerId, uses, spoolId:(uses[0] || {}).spoolId || '', grams:r2(sumG(uses)), hours:p.hours,
    clientId:ord ? ord.clientId || '' : '', client:ord ? clientName(ord) : '', orderId:p.orderId || '', itemId:p.itemId || '', planId:p.id, quoteId:ord ? ord.quoteId || '' : ''});
}

/* ---------- vistas: encomendas e produção ---------- */
function vOrders(){
  const f = st.oFilter;
  const rows = S.orders.map(o => ({o, s:orderState(o)})).filter(({s}) => f === 'todas' || (f === 'curso' ? s.open : s.status === f))
    .sort((a, b) => (a.o.due || '9').localeCompare(b.o.due || '9'));
  const toConvert = S.quotes.filter(q => q.status === 'aceite' && !orderOf(q));
  const chip = (v, l) => `<button class="chip" data-act="filter" data-k="oFilter" data-v="${v}" aria-pressed="${f === v}">${l}</button>`;
  const openVal = S.orders.filter(o => orderState(o).open).reduce((a, o) => a + (+o.total || 0), 0);
  return `<div class="head"><div><div class="eyebrow">Vendas</div><h1>Encomendas</h1><p>Em curso: <span class="num">${eur(openVal)}</span></p></div></div>
    ${toConvert.length ? `<section class="panel"><div class="panel-h"><h2>Orçamentos aceites por converter</h2></div><ul class="alerts">${toConvert.map(q => `<li><span class="pill ok">Aceite</span><div class="txt">${esc(q.number)} · ${esc(clientName(q) || 'sem cliente')}<small>${eur(calcQuote(q).total)} · prazo ${+q.deliveryDays ? q.deliveryDays + ' dias úteis' : 'não definido'}</small></div><button class="btn sm primary" data-act="convert" data-id="${q.id}">Converter em encomenda</button></li>`).join('')}</ul></section>` : ''}
    <div class="chips">${chip('curso', 'Em curso')}${chip('pronta', 'Prontas')}${chip('entregue', 'Entregues')}${chip('cancelada', 'Canceladas')}${chip('todas', 'Todas')}</div>
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Nº</th><th>Cliente</th><th>Peças</th><th>Prazo</th><th style="width:150px">Produção</th><th>Estado</th><th class="r">Total</th></tr></thead><tbody>
      ${rows.map(({o, s}) => { const [l, c] = OSTATUS[s.status]; const dl = o.due ? businessDaysBetween(today(), o.due) : null; return `<tr class="click" data-act="edit-order" data-id="${o.id}" tabindex="0"><td class="num">${esc(o.number)}</td><td>${esc(clientName(o) || '—')}</td><td class="muted">${esc(s.items.map(i => `${i.qty}× ${i.desc}`).join(', '))}</td>
        <td>${fmtDate(o.due)}${s.late ? '<br><span class="pill bad">Atrasada</span>' : s.open && dl !== null && dl <= 2 ? `<br><span class="pill warn">${dl === 0 ? 'Hoje' : dl + ' dias úteis'}</span>` : ''}</td>
        <td><div class="bar"><i class="${s.done >= s.total ? '' : 'info'}" style="width:${s.pct * 100}%"></i></div><small class="muted num">${s.done}/${s.total} un.${s.toPlan && s.open ? ` · ${s.toPlan} por planear` : ''}</small></td><td><span class="pill ${c}">${l}</span></td><td class="r num"><b>${eur(o.total)}</b></td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty">${S.orders.length ? 'Nenhuma encomenda neste filtro.' : 'Ainda não há encomendas. Quando um orçamento for aceite, converta-o em encomenda a partir do próprio orçamento.'}</div>`}`;
}

function gantt(){
  const days = st.gDays, start = new Date(); start.setHours(0, 0, 0, 0);
  const span = days * 86400e3, end = new Date(start.getTime() + span), now = new Date();
  const pos = d => (d - start) / span * 100;
  const dayMarks = Array.from({length:days}, (_, i) => new Date(start.getTime() + i * 86400e3));
  const hourStep = days === 1 ? 2 : days <= 3 ? 6 : 12;
  const ticks = []; for (let h = 0; h < days * 24; h += hourStep) if (h % 24) ticks.push(h);
  const lanes = S.printers.map(pr => {
    const items = S.plan.filter(p => p.printerId === pr.id && p.start).map(p => ({p, s:new Date(p.start), e:planEnd(p)})).filter(x => x.e > start && x.s < end).sort((a, b) => a.s - b.s);
    const act = items.filter(x => activePlan(x.p)); const over = new Set();
    for (let i = 1; i < act.length; i++) if (act[i].s < act[i - 1].e - 60e3){ over.add(act[i].p.id); over.add(act[i - 1].p.id); }
    return `<div class="g-lane"><div class="g-name">${esc(pr.name)}${pr.status === 'parada' ? '<small>parada</small>' : ''}</div><div class="g-track">
      ${dayMarks.map(d => `<i class="g-sep" style="left:${pos(d)}%"></i>`).join('')}
      ${items.map(({p, s, e}) => { const l = Math.max(0, pos(s)), r = Math.min(100, pos(e)); const late = p.status === 'planeada' && s < new Date(now - 30 * 60e3);
        return `<button type="button" class="g-bar ${p.status}${over.has(p.id) ? ' overlap' : ''}${late ? ' late' : ''}" style="left:${l}%;width:${Math.max(.6, r - l)}%" data-act="edit-plan" data-id="${p.id}" title="${esc(`${p.desc} ×${p.qty} · ${fmtDT(p.start)} → ${fmtT(e)} · ${PSTATUS[p.status][0]}${p.orderNumber ? ' · ' + p.orderNumber : ''}`)}"><b>${esc(p.desc)}${p.qty > 1 ? ' ×' + p.qty : ''}</b><span>${fmtT(s)}–${fmtT(e)}${p.orderNumber ? ' · ' + esc(p.orderNumber) : ''}</span></button>`; }).join('')}
      ${now > start && now < end ? `<i class="g-now" style="left:${pos(now)}%"></i>` : ''}
    </div></div>`;
  }).join('');
  return `<div class="gantt"><div class="g-inner">
    <div class="g-lane g-head"><div class="g-name"></div><div class="g-track">${dayMarks.map((d, i) => `<span class="g-day" style="left:${pos(d)}%;width:${100 / days}%">${i === 0 ? 'Hoje' : d.toLocaleDateString('pt-PT', {weekday:'short', day:'2-digit', month:'2-digit'})}</span>`).join('')}${ticks.map(h => `<span class="g-tick" style="left:${h / (days * 24) * 100}%">${String(h % 24).padStart(2, '0')}h</span>`).join('')}</div></div>
    ${lanes || '<div class="empty">Adicione impressoras para planear a produção.</div>'}
  </div></div>`;
}
function vProduction(){
  const pend = S.orders.map(o => ({o, s:orderState(o)})).filter(x => x.s.open && x.s.toPlan > 0).sort((a, b) => (a.o.due || '9').localeCompare(b.o.due || '9'));
  const now = new Date();
  const queue = S.printers.map(pr => {
    const list = S.plan.filter(p => p.printerId === pr.id && activePlan(p)).sort((a, b) => (a.status === 'a_imprimir' ? 0 : 1) - (b.status === 'a_imprimir' ? 0 : 1) || a.start.localeCompare(b.start));
    const last = list.reduce((m, p) => { const e = planEnd(p); return e > m ? e : m; }, null);
    return `<section class="panel"><div class="panel-h"><div><h2>${esc(pr.name)}</h2><small class="muted">${list.length ? `Livre a partir de ${fmtDT(localDT(last))}` : 'Sem impressões na fila'}</small></div>${list.length > 1 ? `<button class="btn ghost sm" data-act="compact" data-id="${pr.id}">Seguir a fila</button>` : ''}</div>
      ${list.length ? `<ul class="alerts">${list.map(p => { const e = planEnd(p), [l, c] = PSTATUS[p.status]; const late = p.status === 'planeada' && new Date(p.start) < new Date(now - 30 * 60e3); const sps = filsOf(p).map(f => S.spools.find(s => s.id === f.spoolId)).filter(Boolean);
        return `<li><span class="pill ${late ? 'bad' : c}">${late ? 'Atrasada' : l}</span><div class="txt"><b>${esc(p.desc)}${p.qty > 1 ? ' ×' + p.qty : ''}</b><small>${fmtDT(p.start)} → ${fmtT(e)} · ${hm(p.hours)}${p.orderNumber ? ' · ' + esc(p.orderNumber) : ''}${sps.length ? ' · ' + sps.map(sp => swatch(sp.hex) + esc(spoolLabel(sp))).join(', ') : ''}</small></div>
          <span class="actions">${p.status === 'planeada' ? `<button class="btn sm" data-act="plan-start" data-id="${p.id}">Iniciar</button>` : ''}<button class="btn sm ${p.status === 'a_imprimir' ? 'primary' : ''}" data-act="plan-done" data-id="${p.id}">Registar</button><button class="btn ghost sm" data-act="edit-plan" data-id="${p.id}" aria-label="Editar">Editar</button></span></li>`; }).join('')}</ul>` : ''}
    </section>`;
  }).join('');
  const chip = (v, l) => `<button class="chip" data-act="filter" data-k="gDays" data-v="${v}" aria-pressed="${st.gDays === v}">${l}</button>`;
  const todayJobs = S.jobs.filter(j => j.date === today());
  return `<div class="head"><div><div class="eyebrow">Planeamento e registo</div><h1>Produção</h1><p>${S.plan.filter(activePlan).length} impressões na fila · ${todayJobs.length} registadas hoje</p></div>
    <div class="actions"><button class="btn" data-act="new-job">Registar impressão avulsa</button><button class="btn primary" data-act="new-plan">Planear impressão</button></div></div>
    <section class="panel"><div class="panel-h"><h2>Encomendas por planear</h2></div>
      ${pend.length ? `<ul class="alerts">${pend.map(({o, s}) => `<li><span class="pill ${s.late ? 'bad' : 'warn'}">${s.late ? 'Atrasada' : s.toPlan + ' un.'}</span><div class="txt">${esc(o.number)} · ${esc(clientName(o) || 'sem cliente')}<small>Prazo ${fmtDate(o.due)} · ${s.items.filter(i => i.toPlan).map(i => `${i.toPlan}× ${i.desc}`).join(', ')}</small></div><button class="btn sm primary" data-act="plan-order" data-id="${o.id}">Planear</button></li>`).join('')}</ul>` : '<div class="empty">Todas as encomendas em curso estão planeadas.</div>'}
    </section>
    <div class="panel-h"><h2>Cronograma</h2><div class="chips">${chip(1, 'Hoje')}${chip(3, '3 dias')}${chip(7, '7 dias')}</div></div>
    ${gantt()}
    <div class="legend"><span><i class="lg planeada"></i>Planeada</span><span><i class="lg a_imprimir"></i>A imprimir</span><span><i class="lg concluida"></i>Concluída</span><span><i class="lg falhada"></i>Falhada</span><span><i class="lg overlap"></i>Sobreposta</span></div>
    <h2>Fila por impressora</h2>
    <div class="queue">${queue || '<div class="empty">Sem impressoras.</div>'}</div>`;
}

/* ---------- PDF do orçamento ---------- */
function readLogo(file){
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 600, sc = Math.min(1, max / img.width, 240 / img.height);
      const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(img.width * sc)); cv.height = Math.max(1, Math.round(img.height * sc));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      let url = cv.toDataURL('image/png');
      if (url.length > 180000){ const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height; const x = c2.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c2.width, c2.height); x.drawImage(cv, 0, 0); url = c2.toDataURL('image/jpeg', .85); }
      st.logo = url;
      const keep = {}; document.querySelectorAll('#settings-form input, #settings-form textarea').forEach(i => { if (i.id && i.type !== 'file') keep[i.id] = i.value; });
      render(); Object.entries(keep).forEach(([k, v]) => { const el = document.getElementById(k); if (el) el.value = v; });
      toast('Logótipo carregado. Guarde as definições para o manter.');
    };
    img.onerror = () => toast('Não foi possível ler essa imagem.');
    img.src = r.result;
  };
  r.readAsDataURL(file);
}
const JSPDF_SRC = ['vendor/jspdf.umd.min.js'];
let jspdfLoading = null;
function loadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(new Error('load')); }; document.head.appendChild(s); }); }
async function ensureJsPDF(){
  if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
  if (!jspdfLoading) jspdfLoading = (async () => { for (const u of JSPDF_SRC){ try{ await loadScript(u); if (window.jspdf) return; }catch(e){} } throw new Error('jspdf'); })();
  try{ await jspdfLoading; }catch(e){ jspdfLoading = null; throw e; }
  return window.jspdf.jsPDF;
}
// o tipo de letra do PDF só tem o alfabeto latino: troca os espaços especiais e sinais que o Intl usa
const pdfT = s => String(s ?? '').replace(/[    ]/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/−/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF€—–…•]/g, '');
const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x0A7470; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const addDaysStr = (d, n) => { const x = new Date((d || today()) + 'T12:00'); x.setDate(x.getDate() + (+n || 0)); return ymd(x); };
const longDate = d => d ? new Date(d + 'T12:00').toLocaleDateString('pt-PT', {day:'numeric', month:'long', year:'numeric'}) : '—';
const clientMat = code => !code ? '' : code.startsWith('s:') ? (() => { const s = S.spools.find(x => x.id === code.slice(2)); return s ? `${s.material} ${s.color.replace(/\s*\(exemplo\)/, '')}` : ''; })() : code.slice(2);

function quotePdf(jsPDF, q){
  const s = settings(), c = calcQuote(q), cl = S.clients.find(x => x.id === q.clientId) || (q.clientId ? null : q._newClient) || null;
  const doc = new jsPDF({unit:'mm', format:'a4', compress:true});
  const W = 210, H = 297, M = 16, CW = W - 2 * M, BOTTOM = H - 24;
  const acc = hexRgb(s.pdfColor), ink = [28, 34, 32], grey = [104, 114, 110], light = [226, 231, 229];
  const T = (txt, x, y, o) => doc.text(pdfT(txt), x, y, o);
  const font = (size, style = 'normal', col = ink) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...col); };
  const wrap = (txt, w) => doc.splitTextToSize(pdfT(txt), w);
  let y = M;

  // cabeçalho: logótipo à esquerda, empresa à direita
  let logoH = 0;
  if (s.logo){ try{ const p = doc.getImageProperties(s.logo); const r = p.width / p.height; let h = 20, w = h * r; if (w > 60){ w = 60; h = w / r; } doc.addImage(s.logo, p.fileType || 'PNG', M, y, w, h); logoH = h; }catch(e){} }
  font(13, 'bold'); T(s.company, W - M, y + 5, {align:'right'});
  const comp = [...String(s.cAddress || '').split('\n'), [s.cNif ? 'NIF ' + s.cNif : '', s.cPhone].filter(Boolean).join('  ·  '), [s.cEmail, s.cWeb].filter(Boolean).join('  ·  ')].map(x => x.trim()).filter(Boolean);
  font(8.5, 'normal', grey); comp.forEach((l, i) => T(l, W - M, y + 10.5 + i * 4, {align:'right'}));
  y = Math.max(y + logoH, y + 10.5 + comp.length * 4) + 4;
  doc.setDrawColor(...acc); doc.setLineWidth(0.9); doc.line(M, y, W - M, y);
  y += 12;

  // título e dados do orçamento
  font(24, 'bold', acc); T('Orçamento', M, y);
  font(11, 'bold'); T(q.number, M, y + 7);
  const meta = [['Data', longDate(q.date)], ['Válido até', longDate(addDaysStr(q.date, q.validity))], ['Prazo de entrega', +q.deliveryDays ? `${q.deliveryDays} dias úteis após aceitação` : 'A combinar']];
  meta.forEach(([k, v], i) => { font(8, 'normal', grey); T(k, 118, y - 6 + i * 6.5); font(9.5, 'bold'); T(v, W - M, y - 6 + i * 6.5, {align:'right'}); });
  y += 16;

  // cliente
  const cname = clientName(q) || (cl && cl.name) || '';
  if (cname){
    const lines = [cl && cl.nif ? 'NIF ' + cl.nif : '', ...String(cl && cl.address || '').split('\n'), [cl && cl.email, cl && cl.phone].filter(Boolean).join('  ·  ')].map(x => (x || '').trim()).filter(Boolean);
    const bh = 15.5 + lines.length * 4.3;
    doc.setFillColor(...acc.map(v => Math.round(v * 0.08 + 255 * 0.92))); doc.roundedRect(M, y, CW, bh, 2, 2, 'F');
    font(7.5, 'bold', acc); T('CLIENTE', M + 5, y + 6);
    font(11, 'bold'); T(cname, M + 5, y + 11.5);
    font(8.5, 'normal', grey); lines.forEach((l, i) => T(l, M + 5, y + 16.5 + i * 4.3));
    y += bh + 8;
  }

  // tabela de peças
  const thumbs = (q.items || []).some(it => it.thumb);
  const cols = [];
  if (thumbs) cols.push({k:'img', w:17});
  cols.push({k:'desc', label:'Descrição', w:0}, {k:'qty', label:'Qtd.', w:14, a:'right'}, {k:'unit', label:'Preço unit.', w:26, a:'right'}, {k:'disc', label:'Desconto', w:19, a:'right'}, {k:'total', label:'Total', w:27, a:'right'});
  const fixed = cols.reduce((a, x) => a + x.w, 0); cols.find(x => x.k === 'desc').w = CW - fixed;
  let cx = M; cols.forEach(x => { x.x = cx; cx += x.w; });
  const header = () => {
    doc.setFillColor(...acc); doc.rect(M, y, CW, 8, 'F'); font(8, 'bold', [255, 255, 255]);
    cols.forEach(x => { if (x.label) T(x.label, x.a === 'right' ? x.x + x.w - 2.5 : x.x + 2.5, y + 5.3, x.a === 'right' ? {align:'right'} : undefined); });
    y += 8;
  };
  const rows = (q.items || []).map((it, i) => {
    const l = c.lines[i] || {};
    const sub = [it.ref ? 'Ref. ' + it.ref : '', (() => { const ms = [...new Set(filsOf(it).map(f => clientMat(f.mat)).filter(Boolean))]; return ms.length ? (ms.length > 1 ? 'Materiais: ' : 'Material: ') + ms.join(', ') : ''; })()].filter(Boolean).join('  ·  ');
    return {thumb:it.thumb, title:it.desc || 'Peça', sub, qty:String(it.qty), unit:eur(l.unitPrice), disc:l.disc ? `${num(it.disc, it.disc % 1 ? 1 : 0)}%` : '—', discSub:l.disc ? '-' + eur(l.disc) : '', total:eur(l.net)};
  });
  if (c.extraLaborPrice > 0.004) rows.push({title:'Mão de obra adicional', sub:'Preparação, acabamentos ou design', qty:'', unit:'', disc:'', total:eur(c.extraLaborPrice)});
  if (c.extras > 0.004) rows.push({title:'Outros custos', sub:'', qty:'', unit:'', disc:'', total:eur(c.extras)});
  header();
  const dw = cols.find(x => x.k === 'desc');
  rows.forEach((r, i) => {
    font(9.5, 'bold'); const tl = wrap(r.title, dw.w - 5);
    font(8, 'normal'); const sl = r.sub ? wrap(r.sub, dw.w - 5) : [];
    const textH = tl.length * 4.4 + sl.length * 3.8;
    const rh = Math.max(thumbs && r.thumb ? 17 : 0, textH + 6, 10);
    if (y + rh > BOTTOM){ doc.addPage(); y = M; header(); }
    if (i % 2 === 1){ doc.setFillColor(248, 249, 249); doc.rect(M, y, CW, rh, 'F'); }
    if (thumbs && r.thumb){ try{ const p = doc.getImageProperties(r.thumb); const rr = p.width / p.height; let w = 14, h = 14; if (rr > 1) h = 14 / rr; else w = 14 * rr; doc.addImage(r.thumb, p.fileType || 'PNG', M + 1.5 + (14 - w) / 2, y + (rh - h) / 2, w, h); }catch(e){} }
    let ty = y + (rh - textH) / 2 + 3.3;
    font(9.5, 'bold'); tl.forEach(t => { doc.text(t, dw.x + 2.5, ty); ty += 4.4; });
    font(8, 'normal', grey); sl.forEach(t => { doc.text(t, dw.x + 2.5, ty - 0.4); ty += 3.8; });
    const mid = y + rh / 2 + 1.3;
    const right = (k, v, style = 'normal', col = ink, dy = 0) => { const cc = cols.find(x => x.k === k); font(9, style, col); T(v, cc.x + cc.w - 2.5, mid + dy, {align:'right'}); };
    right('qty', r.qty); right('unit', r.unit);
    if (r.discSub){ right('disc', r.disc, 'normal', ink, -1.8); font(7.5, 'normal', grey); const cc = cols.find(x => x.k === 'disc'); T(r.discSub, cc.x + cc.w - 2.5, mid + 2.2, {align:'right'}); } else right('disc', r.disc, 'normal', grey);
    right('total', r.total, 'bold');
    y += rh; doc.setDrawColor(...light); doc.setLineWidth(0.2); doc.line(M, y, W - M, y);
  });
  y += 7;

  // totais (direita) e observações (esquerda)
  const tot = [['Subtotal', eur(c.gross)]];
  if (c.discount > 0.004) tot.push(['Descontos', '-' + eur(c.discount)]);
  tot.push(['Total sem IVA', eur(c.net)]);
  tot.push(q.vat ? [`IVA (${num(s.vat)}%)`, eur(c.vat)] : ['IVA', 'Não incluído']);
  const tH = tot.length * 6 + 14;
  font(9); const notes = q.notes ? wrap(q.notes, 92) : [];
  if (y + Math.max(tH, notes.length * 4 + 8) > BOTTOM){ doc.addPage(); y = M; }
  const tx = W - M - 78;
  tot.forEach(([k, v], i) => { font(9, 'normal', grey); T(k, tx, y + 4 + i * 6); font(9.5, k === 'Descontos' ? 'normal' : 'normal'); T(v, W - M, y + 4 + i * 6, {align:'right'}); });
  const by = y + tot.length * 6 + 1.5;
  doc.setFillColor(...acc); doc.roundedRect(tx - 3, by, 81, 11, 1.5, 1.5, 'F');
  font(10, 'bold', [255, 255, 255]); T(q.vat ? 'Total com IVA' : 'Total', tx, by + 7.2); font(13, 'bold', [255, 255, 255]); T(eur(c.total), W - M - 2, by + 7.4, {align:'right'});
  if (notes.length){ font(7.5, 'bold', acc); T('OBSERVAÇÕES', M, y + 4); font(9, 'normal'); notes.forEach((t, i) => doc.text(t, M, y + 9.5 + i * 4.2)); }
  y = Math.max(by + 11, y + 9.5 + notes.length * 4.2) + 8;

  // condições, pagamento e aceitação
  const cond = [s.cond, s.cIban ? `Pagamento por transferência bancária para o IBAN ${s.cIban}.` : ''].filter(Boolean).join('\n');
  if (cond){
    font(8.5); const cl2 = wrap(cond, CW);
    if (y + cl2.length * 4 + 10 > BOTTOM){ doc.addPage(); y = M; }
    font(7.5, 'bold', acc); T('CONDIÇÕES', M, y); font(8.5, 'normal', grey); cl2.forEach((t, i) => doc.text(t, M, y + 5 + i * 4)); y += 5 + cl2.length * 4 + 5;
  }
  if (y + 16 > H - 16){ doc.addPage(); y = M; }
  font(8.5, 'normal', grey); T('Aceito o presente orçamento nas condições indicadas.', M, y);
  doc.setDrawColor(...grey); doc.setLineWidth(0.2); doc.line(M, y + 11, M + 85, y + 11); doc.line(W - M - 50, y + 11, W - M, y + 11);
  font(7.5, 'normal', grey); T('Assinatura do cliente', M, y + 15); T('Data', W - M - 50, y + 15);

  // rodapé em todas as páginas
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++){
    doc.setPage(i); doc.setDrawColor(...light); doc.setLineWidth(0.3); doc.line(M, H - 14, W - M, H - 14);
    font(7.5, 'normal', grey); T([s.company, s.cNif ? 'NIF ' + s.cNif : '', s.cEmail].filter(Boolean).join('  ·  '), M, H - 9.5);
    T(`${q.number}  ·  Página ${i} de ${n}`, W - M, H - 9.5, {align:'right'});
  }
  doc.setProperties({title:pdfT(`Orçamento ${q.number}`), subject:pdfT(cname), creator:pdfT(s.company)});
  return doc;
}
async function exportQuotePdf(q){
  if (!(q.items || []).length){ toast('Adicione peças ao orçamento antes de gerar o PDF.'); return; }
  toast('A gerar o PDF…');
  let jsPDF;
  try{ jsPDF = await ensureJsPDF(); }catch(e){ toast('Não foi possível carregar o gerador de PDF. Verifique a ligação e tente de novo.'); return; }
  let doc;
  try{ doc = quotePdf(jsPDF, q); }catch(e){ console.error(e); toast('Ocorreu um erro ao montar o PDF.'); return; }
  const name = `Orcamento ${q.number}${clientName(q) ? ' - ' + clientName(q) : ''}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
  const blob = doc.output('blob'), file = new File([blob], name, {type:'application/pdf'});
  const share = canShareFile(file);
  openPdfReady(name, blob, file, share);
}
function openPdfReady(name, blob, file, share){
  const d = document.createElement('dialog'); d.className = 'mini';
  d.innerHTML = `<div class="dlg"><div class="dlg-h"><h2>PDF pronto</h2></div><div class="dlg-b"><p style="margin:0"><b>${esc(name)}</b></p><p class="muted" style="margin:0">${share ? 'Guarde no aparelho ou partilhe diretamente por email, WhatsApp, etc.' : 'Guarde o ficheiro e anexe-o ao email para o cliente.'}</p></div>
    <div class="dlg-f"><div class="actions"><button type="button" class="btn" data-x="close">Fechar</button>${share ? '<button type="button" class="btn" data-x="share">Partilhar…</button>' : ''}<button type="button" class="btn primary" data-x="save">Guardar PDF</button></div></div></div>`;
  document.body.appendChild(d); d.showModal();
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]'); if (!x) return;
    if (x.dataset.x === 'save'){ await downloads.save({filename:name, data:blob}); toast('PDF guardado.'); d.close(); }
    else if (x.dataset.x === 'share'){ try{ await navigator.share({files:[file], title:name}); d.close(); }catch(err){ if (err && err.name !== 'AbortError') toast('Não foi possível partilhar.'); } }
    else d.close();
  });
}

/* ---------- diálogo ---------- */
let onSubmit = null, onInput = null, onGcode = null;
function openDlg(title, body, {wide = false, submit = 'Guardar', extra = '', handler, input} = {}){
  const d = $('#dlg');
  d.className = wide ? 'wide' : '';
  d.innerHTML = `<form class="dlg" id="dlg-form" novalidate><div class="dlg-h"><h2>${esc(title)}</h2><button type="button" class="btn ghost" data-act="close" aria-label="Fechar">✕</button></div>
    <div class="dlg-b">${body}</div>
    <div class="dlg-f">${extra}<div class="actions"><button type="button" class="btn" data-act="close">Cancelar</button>${submit ? `<button type="submit" class="btn primary">${esc(submit)}</button>` : ''}</div></div></form>`;
  onSubmit = handler; onInput = input || null; onGcode = null;
  if (!d.open) d.showModal();
  if (onInput) onInput();
}
function closeDlg(){ const d = $('#dlg'); if (d.open) d.close(); onSubmit = onInput = onGcode = null; }
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3200); }
const F = (id, label, inner, cls = '') => `<div class="field ${cls}"><label for="${id}">${label}</label>${inner}</div>`;
const inp = (id, v = '', type = 'text', attrs = '') => `<input id="${id}" type="${type}" value="${esc(v)}" ${attrs}>`;
const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
function confirmDlg(title, msg, label, fn){
  openDlg(title, `<p style="margin:0">${msg}</p>`, {submit:label, handler: async () => { await fn(); closeDlg(); }});
}

/* ---------- formulários ---------- */
function spoolForm(s){
  const isNew = !s; s = s ? cp(s) : {id:uid(), material:'PLA', color:'', hex:'#2B2B2B', brand:'', diameter:'1.75', weight:1000, remaining:1000, tare:200, price:20, bought:today(), location:''};
  const mats = Object.keys(settings().matPrices).concat('Outro');
  openDlg(isNew ? 'Nova bobine' : 'Editar bobine', `
    <div class="row">${F('sp-mat', 'Material', sel('sp-mat', mats.map(m => [m, m]), s.material))}${F('sp-brand', 'Marca', inp('sp-brand', s.brand))}${F('sp-diam', 'Diâmetro (mm)', sel('sp-diam', [['1.75', '1,75'], ['2.85', '2,85']], s.diameter))}</div>
    <div class="row">${F('sp-color', 'Cor', inp('sp-color', s.color, 'text', 'placeholder="ex.: Preto mate" required'))}${F('sp-hex', 'Amostra de cor', inp('sp-hex', s.hex, 'color', 'style="height:40px;padding:4px"'))}${F('sp-loc', 'Localização', inp('sp-loc', s.location, 'text', 'placeholder="ex.: Caixa seca A"'))}</div>
    <div class="row">${F('sp-weight', 'Peso líquido (g)', inp('sp-weight', s.weight, 'number', 'min="1" step="1"'))}${F('sp-rem', 'Restante (g)', inp('sp-rem', s.remaining, 'number', 'step="1"'))}${F('sp-tare', 'Peso da bobine vazia (g)', inp('sp-tare', s.tare, 'number', 'min="0" step="1"'), '')}</div>
    <div class="row">${F('sp-price', 'Preço pago (€)', inp('sp-price', s.price, 'number', 'min="0" step="0.01"'))}${F('sp-bought', 'Data de compra', inp('sp-bought', s.bought, 'date'))}</div>`,
  {handler: async () => {
    if (!val('sp-color').trim()){ toast('Indique a cor da bobine.'); return; }
    Object.assign(s, {material:val('sp-mat'), brand:val('sp-brand').trim(), diameter:val('sp-diam'), color:val('sp-color').trim(), hex:val('sp-hex'), location:val('sp-loc').trim(),
      weight:numv('sp-weight'), remaining:numv('sp-rem'), tare:numv('sp-tare'), price:numv('sp-price'), bought:val('sp-bought')});
    await put('spools', s); closeDlg(); toast(isNew ? 'Bobine adicionada.' : 'Bobine atualizada.');
  }});
}
function weighForm(s){
  s = cp(s);
  openDlg('Pesar bobine', `<p style="margin:0">${esc(spoolLabel(s))} · restante registado <b class="num">${num(spoolRemain(s))} g</b></p>
    <div class="row">${F('w-gross', 'Peso na balança (g)', inp('w-gross', '', 'number', 'min="0" step="1" autofocus'))}${F('w-tare', 'Bobine vazia (g)', inp('w-tare', s.tare || 0, 'number', 'min="0" step="1"'))}</div>
    <p class="muted" id="w-out" style="margin:0">Pese a bobine com o filamento para corrigir o valor restante.</p>`,
  {submit:'Atualizar restante', input: () => { const g = numv('w-gross'); $('#w-out').textContent = g ? `Novo restante: ${num(Math.max(0, g - numv('w-tare')))} g` : 'Pese a bobine com o filamento para corrigir o valor restante.'; },
   handler: async () => { const g = numv('w-gross'); if (!g){ toast('Indique o peso na balança.'); return; } s.tare = numv('w-tare'); s.remaining = Math.max(0, g - s.tare); await put('spools', s); closeDlg(); toast('Restante atualizado.'); }});
}

function printerForm(p){
  const isNew = !p; p = p ? cp(p) : {id:uid(), name:'', model:'', watts:120, price:400, life:5000, hours:0, status:'ativa', tasks: DEFAULT_TASKS.map(([n, i]) => ({id:uid(), name:n, interval:i, last:0}))};
  const taskRow = t => `<div class="row task-row" data-id="${t.id}" data-last="${t.last || 0}" style="grid-template-columns:minmax(0,1fr) 110px 32px;align-items:end">${F('t-n-' + t.id, 'Tarefa', inp('t-n-' + t.id, t.name))}${F('t-i-' + t.id, 'A cada (h)', inp('t-i-' + t.id, t.interval, 'number', 'min="1" step="1"'))}<button type="button" class="btn ghost" data-act="rm-row" aria-label="Remover tarefa">✕</button></div>`;
  openDlg(isNew ? 'Nova impressora' : 'Editar impressora', `
    <div class="row">${F('p-name', 'Nome', inp('p-name', p.name, 'text', 'placeholder="ex.: Bambu P1S nº1"'))}${F('p-model', 'Modelo', inp('p-model', p.model))}${F('p-status', 'Estado', sel('p-status', [['ativa', 'Ativa'], ['manutencao', 'Em manutenção'], ['parada', 'Parada']], p.status))}</div>
    <div class="row">${F('p-watts', 'Consumo médio (W)', inp('p-watts', p.watts, 'number', 'min="0" step="1"'))}${F('p-price', 'Preço de compra (€)', inp('p-price', p.price, 'number', 'min="0" step="1"'))}${F('p-life', 'Vida útil estimada (h)', inp('p-life', p.life, 'number', 'min="1" step="100"'))}${F('p-hours', 'Horas acumuladas', inp('p-hours', p.hours, 'number', 'min="0" step="0.1"'))}</div>
    <p class="muted" style="margin:0">Desgaste por hora usado nos orçamentos: <b class="num" id="p-wear"></b></p>
    <h3>Plano de manutenção</h3>
    <div id="task-rows" class="items">${(p.tasks || []).map(taskRow).join('')}</div>
    <div><button type="button" class="btn sm" data-act="add-task">Adicionar tarefa</button></div>`,
  {input: () => { const l = numv('p-life'); $('#p-wear').textContent = l ? eur(numv('p-price') / l) : '—'; },
   handler: async () => {
    if (!val('p-name').trim()){ toast('Indique o nome da impressora.'); return; }
    Object.assign(p, {name:val('p-name').trim(), model:val('p-model').trim(), status:val('p-status'), watts:numv('p-watts'), price:numv('p-price'), life:numv('p-life'), hours:numv('p-hours')});
    p.tasks = [...document.querySelectorAll('.task-row')].map(r => ({id:r.dataset.id, name:val('t-n-' + r.dataset.id).trim(), interval:numv('t-i-' + r.dataset.id), last:+r.dataset.last || 0})).filter(t => t.name && t.interval);
    await put('printers', p); closeDlg(); toast(isNew ? 'Impressora adicionada.' : 'Impressora atualizada.');
  }});
  printerForm.taskRow = taskRow;
}

function maintForm(printerId){
  if (!S.printers.length){ toast('Adicione primeiro uma impressora.'); return; }
  const pid = printerId || S.printers[0].id;
  const taskOpts = id => { const p = S.printers.find(x => x.id === id); return (p ? p.tasks || [] : []).map(t => [t.id, t.name]).concat([['__outra', 'Outra intervenção']]); };
  const p0 = S.printers.find(x => x.id === pid);
  openDlg('Registar manutenção', `
    <div class="row">${F('m-printer', 'Impressora', sel('m-printer', S.printers.map(p => [p.id, p.name]), pid))}${F('m-task', 'Intervenção', sel('m-task', taskOpts(pid), ''))}</div>
    <div class="field" id="m-other-w" hidden><label for="m-other">Descrição</label>${inp('m-other', '', 'text', 'placeholder="ex.: Substituição do ventilador"')}</div>
    <div class="row">${F('m-date', 'Data', inp('m-date', today(), 'date'))}${F('m-hours', 'Horas da máquina', inp('m-hours', p0.hours || 0, 'number', 'min="0" step="0.1"'))}${F('m-cost', 'Custo de peças (€)', inp('m-cost', 0, 'number', 'min="0" step="0.01"'))}</div>
    ${F('m-notes', 'Notas', '<textarea id="m-notes"></textarea>')}
    <label class="check"><input type="checkbox" id="m-reset" checked> Reiniciar o contador desta tarefa</label>`,
  {input: () => { $('#m-other-w').hidden = val('m-task') !== '__outra'; },
   handler: async () => {
    const p = cp(S.printers.find(x => x.id === val('m-printer'))), tid = val('m-task');
    const t = (p.tasks || []).find(x => x.id === tid);
    const name = t ? t.name : val('m-other').trim();
    if (!name){ toast('Descreva a intervenção.'); return; }
    const hoursAt = numv('m-hours');
    await put('maint', {id:uid(), printerId:p.id, taskId:t ? t.id : '', task:name, date:val('m-date'), hoursAt, cost:numv('m-cost'), notes:val('m-notes').trim()});
    if (t && $('#m-reset').checked){ t.last = hoursAt; await put('printers', p); }
    closeDlg(); toast('Manutenção registada.');
  }});
  maintForm.taskOpts = taskOpts;
}

function jobForm(j, prefill){
  if (!S.printers.length || !S.spools.length){ toast('Adicione primeiro uma impressora e uma bobine.'); return; }
  const isNew = !j, old = j ? cp(j) : null;
  j = j ? cp(j) : {id:uid(), date:today(), name:'', client:'', clientId:'', partId:'', qty:1, printerId:S.printers[0].id, spoolId:(S.spools.find(s => spoolRemain(s) > 0) || S.spools[0]).id, grams:0, hours:0, result:'sucesso', reason:'', quoteId:'', orderId:'', itemId:'', planId:'', notes:''};
  if (prefill) Object.entries(prefill).forEach(([k, v]) => { if (v !== undefined) j[k] = v; });
  const ordJ = j.orderId && S.orders.find(o => o.id === j.orderId);
  const jf = usesOf(j).map(u => ({spoolId:u.spoolId, mat:u.spoolId ? 's:' + u.spoolId : '', grams:u.grams}));
  const H = Math.floor(j.hours || 0), M = Math.round(((j.hours || 0) - H) * 60);
  let lastPart = j.partId, lastQty = j.qty || 1;
  openDlg(isNew ? 'Registar impressão' : 'Editar impressão', `
    ${ordJ ? `<p class="ctx">Encomenda <b class="mono">${esc(ordJ.number)}</b> · ${esc(clientName(ordJ) || 'sem cliente')}${j.planId ? ' · impressão planeada' : ''}. Se marcar "Falha", as unidades voltam a ficar por planear.</p>` : ''}
    <div class="row">${F('j-part', 'Peça do catálogo', `<select id="j-part"><option value="">— Escolher para preencher —</option>${[...S.parts].sort((a, b) => a.name.localeCompare(b.name, 'pt')).map(p => `<option value="${p.id}" ${j.partId === p.id ? 'selected' : ''}>${esc(p.name)}${clientName(p) ? ' · ' + esc(clientName(p)) : ''}</option>`).join('')}</select>`)}${F('j-qty', 'Unidades nesta impressão', inp('j-qty', j.qty || 1, 'number', 'min="1" step="1"'))}</div>
    <details class="gimport"><summary>Ou ler os dados de um G-code</summary>${dropZone(false, 'Preenche a peça, o filamento gasto, o tempo e a bobine a partir do ficheiro do slicer.')}</details>
    <div class="row">${F('j-name', 'Peça / trabalho', inp('j-name', j.name, 'text', 'placeholder="ex.: Suporte de parede"'))}${F('j-date', 'Data', inp('j-date', j.date, 'date'))}</div>
    <div class="row">${F('j-printer', 'Impressora', sel('j-printer', S.printers.map(p => [p.id, p.name]), j.printerId))}</div>
    <div class="field"><label>Filamento gasto, por bobine (até ${MAXF})</label>${filEditor('j', jf.length ? jf : [{spoolId:(S.spools.find(s => spoolRemain(s) > 0) || S.spools[0]).id, mat:'', grams:0}], 'spool')}</div>
    <div class="row">${F('j-h', 'Tempo: horas', inp('j-h', H, 'number', 'min="0" step="1"'))}${F('j-m', 'minutos', inp('j-m', M, 'number', 'min="0" max="59" step="1"'))}</div>
    <div class="row">${F('j-result', 'Resultado', sel('j-result', [['sucesso', 'Sucesso'], ['falha', 'Falha']], j.result))}<div class="field" id="j-reason-w"><label for="j-reason">Motivo da falha</label>${sel('j-reason', [['', '—'], ['Descolou da base', 'Descolou da base'], ['Entupimento', 'Entupimento'], ['Falta de filamento', 'Falta de filamento'], ['Layer shift', 'Layer shift'], ['Warping', 'Warping'], ['Falha de energia', 'Falha de energia'], ['Outro', 'Outro']], j.reason)}</div></div>
    <div class="row">${F('j-client', 'Cliente', sel('j-client', clientOpts([['', 'Sem cliente']]).concat(j.clientId || !j.client ? [] : [['__legacy', j.client + ' (sem ficha)']]), j.clientId || (j.client ? '__legacy' : '')))}${F('j-quote', 'Orçamento associado', sel('j-quote', [['', 'Nenhum']].concat(S.quotes.map(q => [q.id, `${q.number} · ${clientName(q)}`])), j.quoteId))}</div>
    ${F('j-notes', 'Notas', `<textarea id="j-notes">${esc(j.notes)}</textarea>`)}
    <p class="muted" style="margin:0">O filamento gasto é descontado de cada bobine e o tempo é somado às horas da impressora.</p>`,
  {input: () => {
    $('#j-reason-w').hidden = val('j-result') !== 'falha';
    const pid = val('j-part'), qty = Math.max(1, numv('j-qty'));
    if (pid && (pid !== lastPart || qty !== lastQty)){
      const p = S.parts.find(x => x.id === pid);
      if (p){
        $('#j-name').value = p.name + (qty > 1 ? ` ×${qty}` : '');
        setHM('j', (+p.hours || 0) * qty);
        if (p.clientId && S.clients.some(c => c.id === p.clientId)) $('#j-client').value = p.clientId;
        setFils('j', filsToSpools(filsOf(p), qty));
      }
    }
    lastPart = pid; lastQty = qty;
    filsUpdated('j');
  },
   handler: async () => {
    if (!val('j-name').trim()){ toast('Indique o nome da peça.'); return; }
    const uses = readFils('j').map(f => ({spoolId:f.spoolId || '', grams:r2(f.grams)})).filter(u => u.grams > 0 || u.spoolId);
    Object.assign(j, {name:val('j-name').trim(), date:val('j-date'), printerId:val('j-printer'), uses, spoolId:(uses[0] || {}).spoolId || '', grams:r2(sumG(uses)), hours:r2(numv('j-h') + numv('j-m') / 60),
      result:val('j-result'), reason:val('j-result') === 'falha' ? val('j-reason') : '', clientId:val('j-client').startsWith('__') ? '' : val('j-client'), client:val('j-client') === '__legacy' ? j.client : clientName({clientId:val('j-client')}), partId:val('j-part'), qty:Math.max(1, numv('j-qty')), quoteId:val('j-quote'), notes:val('j-notes').trim()});
    await applyJob(old, j); await put('jobs', j);
    if (j.planId){ const pl = S.plan.find(x => x.id === j.planId); if (pl){ const c = cp(pl); c.status = j.result === 'sucesso' ? 'concluida' : 'falhada'; c.jobId = j.id; await put('plan', c); } }
    closeDlg(); toast(isNew ? 'Impressão registada.' : 'Impressão atualizada.');
  }});
  onGcode = r => {
    if (!val('j-name').trim() || $('#j-name').dataset.fromGcode) { $('#j-name').value = r.name; $('#j-name').dataset.fromGcode = '1'; }
    if (r.fils && r.fils.length) setFils('j', gcodeFils(r, 'spool'));
    if (r.hours){ const H = Math.floor(r.hours), M = Math.round((r.hours - H) * 60); $('#j-h').value = M === 60 ? H + 1 : H; $('#j-m').value = M === 60 ? 0 : M; }
    if (r.src || r.file){ const n = $('#j-notes'); const line = `G-code: ${r.file} (${srcLine(r)})`; if (!n.value.includes(line)) n.value = (n.value ? n.value + '\n' : '') + line; }
  };
}
async function applyJob(oldJ, newJ){
  const g = {}, h = {};
  if (oldJ){ usesOf(oldJ).forEach(u => { if (u.spoolId) g[u.spoolId] = (g[u.spoolId] || 0) + u.grams; }); h[oldJ.printerId] = (h[oldJ.printerId] || 0) - (+oldJ.hours || 0); }
  if (newJ){ usesOf(newJ).forEach(u => { if (u.spoolId) g[u.spoolId] = (g[u.spoolId] || 0) - u.grams; }); h[newJ.printerId] = (h[newJ.printerId] || 0) + (+newJ.hours || 0); }
  for (const [id, d] of Object.entries(g)){ const s = S.spools.find(x => x.id === id); if (s && d){ const c = cp(s); c.remaining = r2((+c.remaining || 0) + d); await put('spools', c); } }
  for (const [id, d] of Object.entries(h)){ const p = S.printers.find(x => x.id === id); if (p && d){ const c = cp(p); c.hours = r2(Math.max(0, (+c.hours || 0) + d)); await put('printers', c); } }
}

/* ---------- leitura de G-code ---------- */
const DENS = {PLA:1.24, PETG:1.27, ABS:1.04, ASA:1.07, TPU:1.21, PC:1.20, PA:1.14, PVA:1.23, HIPS:1.04};
const sumList = s => String(s).split(/[,;]/).map(x => parseFloat(x)).filter(x => !isNaN(x)).reduce((a, b) => a + b, 0);
function parseDuration(s){
  s = String(s || '').trim(); let t = 0, any = false, m;
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
  while ((m = re.exec(s))){ any = true; t += +m[1] * {d:86400, h:3600, m:60, s:1}[m[2].toLowerCase()]; }
  if (!any){ const p = s.split(':').map(Number); if (p.length >= 2 && p.every(x => !isNaN(x))) t = p.reduce((a, x) => a * 60 + x, 0); else if (/^\d+(\.\d+)?$/.test(s)) t = +s; }
  return t;
}
const g1 = (txt, re) => { const m = txt.match(re); return m ? m[1].trim() : null; };
function parseGcodeText(txt){
  const r = {slicer:'', grams:null, seconds:null, type:'', fils:[], layer:'', nozzle:'', thumb:'', estimated:false};
  // slicer
  let sl = g1(txt, /^;\s*generated by\s+(.+)$/im);
  if (sl) sl = sl.replace(/\s+on\s+\d{4}-.*$/i, '').replace(/\s+at\s+.*$/i, '');
  sl = sl || (g1(txt, /^;\s*((?:BambuStudio|OrcaSlicer|Bambu Studio)\s*[\d.]*)/im)) || (/Cura_SteamEngine\s*([\d.]+)/.test(txt) ? 'Ultimaker Cura ' + g1(txt, /Cura_SteamEngine\s*([\d.]+)/) : '') || (/Simplify3D/i.test(txt) ? 'Simplify3D' : '') || (/;FLAVOR:/.test(txt) ? 'Cura' : '');
  r.slicer = (sl || '').trim();
  // filamentos: listas por extrusora / ranhura do AMS (gramas, tipo, cor)
  const list = v => v === null ? [] : String(v).split(/[;,]/).map(x => x.replace(/"/g, '').trim());
  const nums = v => list(v).map(x => parseFloat(x)).map(x => isNaN(x) ? 0 : x);
  let gl = nums(g1(txt, /^;\s*filament used \[g\]\s*[:=]\s*([\d.,;\s]+)$/im));
  if (!gl.some(x => x > 0)) gl = nums(g1(txt, /^;\s*total filament (?:weight|used)\s*\[g\]\s*[:=]\s*([\d.,;\s]+)$/im));
  if (!gl.some(x => x > 0)) gl = nums(g1(txt, /^;\s*Plastic weights?:\s*([\d.,\s]+)\s*g/im));
  const types = list(g1(txt, /^;\s*filament_type\s*=\s*(.+)$/im) || g1(txt, /^;\s*filament_settings_id\s*=\s*(.+)$/im));
  const cols = list(g1(txt, /^;\s*filament_colou?r\s*=\s*(.+)$/im) || g1(txt, /^;\s*extruder_colou?r\s*=\s*(.+)$/im)).map(c => /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toUpperCase() : '');
  const diams = nums(g1(txt, /^;\s*filament_diameter\s*=\s*([\d.,;\s]+)$/im));
  const denss = nums(g1(txt, /^;\s*filament_density\s*=\s*([\d.,;\s]+)$/im));
  const typeAt = i => (types[i] || types[0] || '').replace(/^[^A-Za-z]*/, '').split(/\s+/)[0] || '';
  const densAt = i => denss[i] || DENS[typeAt(i).toUpperCase()] || 1.24;
  if (!gl.some(x => x > 0)){
    // sem gramas no ficheiro: calcular pelo comprimento ou volume de cada filamento
    let mm = nums(g1(txt, /^;\s*filament used \[mm\]\s*[:=]\s*([\d.,;\s]+)$/im));
    if (!mm.some(x => x > 0)) mm = nums(g1(txt, /^;\s*Filament used:\s*([\d.,m\s]+)$/im)).map(x => x * 1000);
    if (!mm.some(x => x > 0)) mm = nums(g1(txt, /^;\s*Filament length:\s*([\d.,\s]+)\s*mm/im));
    if (mm.some(x => x > 0)) gl = mm.map((x, i) => x * Math.PI * ((diams[i] || diams[0] || 1.75) / 2) ** 2 / 1000 * densAt(i));
    else {
      const vol = [...txt.matchAll(/;EXTRUDER_TRAIN\.(\d+)\.MATERIAL\.VOLUME_USED:([\d.]+)/g)];
      vol.forEach(m => { gl[+m[1]] = +m[2] / 1000 * densAt(+m[1]); });
    }
    if (gl.some(x => x > 0)) r.estimated = true;
  }
  r.fils = gl.map((x, i) => ({grams:r2(x || 0), type:typeAt(i), hex:cols[i] || ''})).filter(f => f.grams > 0);
  if (r.fils.length) r.grams = sumG(r.fils);
  r.type = [...new Set(r.fils.map(f => f.type).filter(Boolean))].join(' + ') || typeAt(0);
  r.layer = g1(txt, /^;\s*layer_height\s*=\s*([\d.]+)/im) || g1(txt, /^;\s*Layer height:\s*([\d.]+)/im) || '';
  r.nozzle = (g1(txt, /^;\s*nozzle_diameter\s*=\s*([\d.,]+)/im) || g1(txt, /^;EXTRUDER_TRAIN\.0\.NOZZLE\.DIAMETER:([\d.]+)/m) || '').split(',')[0];
  // tempo
  const t = g1(txt, /;\s*total estimated time:\s*([^;\n]+)/i) || g1(txt, /^;\s*estimated printing time \(normal mode\)\s*=\s*(.+)$/im)
    || g1(txt, /^;PRINT\.TIME:(\d+)/m) || g1(txt, /^;TIME:(\d+)/m) || g1(txt, /^;\s*Build time:\s*(.+)$/im)
    || g1(txt, /^;\s*(?:estimated )?print(?:ing)? time[^:=\n]*[:=]\s*([^\n;]+)$/im);
  if (t !== null){ const s = parseDuration(t); if (s > 0) r.seconds = s; }
  // miniatura (a mais pequena que seja legível)
  const th = [...txt.matchAll(/;\s*thumbnail(_JPG|_PNG)?\s+begin\s+(\d+)x(\d+)\s+\d+\s*\r?\n([\s\S]*?);\s*thumbnail(?:_JPG|_PNG)?\s+end/gi)]
    .map(m => ({w:+m[2], mime: m[1] && m[1].toUpperCase() === '_JPG' ? 'image/jpeg' : 'image/png', b64: m[4].replace(/^;\s?/gm, '').replace(/\s+/g, '')}))
    .filter(x => x.b64.length < 60000).sort((a, b) => Math.abs(a.w - 160) - Math.abs(b.w - 160));
  if (th[0]) r.thumb = `data:${th[0].mime};base64,${th[0].b64}`;
  return r;
}
async function readHeadTail(file){
  if (file.size <= 3e6) return await file.text();
  return (await file.slice(0, 1.5e6).text()) + '\n' + (await file.slice(file.size - 1.5e6).text());
}
const stem = n => n.replace(/\.(gcode\.3mf|3mf|gcode|gco|g)$/i, '');
async function parseFile(file){
  const name = file.name;
  if (/\.bgcode$/i.test(name)) throw new Error('G-code binário (.bgcode) não é suportado. No PrusaSlicer, desative "G-code binário" nas definições da impressora e exporte de novo.');
  if (/\.3mf$/i.test(name)){
    if (typeof JSZip === 'undefined') throw new Error('Não foi possível abrir ficheiros .3mf neste momento. Exporte como .gcode.');
    const zip = await JSZip.loadAsync(file);
    const plates = Object.keys(zip.files).filter(p => /^Metadata\/plate_\d+\.gcode$/i.test(p)).sort();
    if (!plates.length) throw new Error('Este .3mf não contém G-code. No slicer, faça "Fatiar" e exporte o ficheiro fatiado (.gcode.3mf).');
    let info = null;
    const cfg = zip.file('Metadata/slice_info.config');
    if (cfg){ try{ info = new DOMParser().parseFromString(await cfg.async('string'), 'application/xml'); }catch(e){} }
    const out = [];
    for (const p of plates){
      const n = p.match(/plate_(\d+)/)[1];
      const txt = await zip.file(p).async('string');
      const head = txt.length > 3e6 ? txt.slice(0, 1.5e6) + '\n' + txt.slice(-1.5e6) : txt;
      const r = parseGcodeText(head);
      if (info){
        const plate = [...info.querySelectorAll('plate')].find(pl => { const m = pl.querySelector('metadata[key="index"]'); return m && m.getAttribute('value') === n; });
        if (plate){
          const md = k => { const m = plate.querySelector(`metadata[key="${k}"]`); return m ? m.getAttribute('value') : null; };
          if (md('prediction') && +md('prediction') > 0) r.seconds = +md('prediction');
          const fl = [...plate.querySelectorAll('filament')].map(f => ({grams:r2(+f.getAttribute('used_g') || 0), type:(f.getAttribute('type') || '').trim(), hex:(/^#[0-9a-f]{6}/i.test(f.getAttribute('color') || '') ? f.getAttribute('color').slice(0, 7).toUpperCase() : '')})).filter(f => f.grams > 0);
          if (fl.length){ r.fils = fl; r.grams = sumG(fl); r.estimated = false; r.type = [...new Set(fl.map(f => f.type).filter(Boolean))].join(' + '); }
          else if (md('weight') && +md('weight') > 0){ r.grams = +md('weight'); r.estimated = false; if (r.fils.length === 1) r.fils[0].grams = r.grams; }
        }
      }
      if (!r.slicer) r.slicer = 'Bambu Studio / OrcaSlicer';
      for (const img of [`Metadata/plate_${n}_small.png`, `Metadata/plate_${n}.png`]){
        const z = zip.file(img); if (z){ const b = await z.async('base64'); if (b.length < 60000){ r.thumb = 'data:image/png;base64,' + b; break; } }
      }
      out.push({...r, file:name, name: plates.length > 1 ? `${stem(name)} — placa ${n}` : stem(name)});
    }
    return out.map(finishParse);
  }
  const r = parseGcodeText(await readHeadTail(file));
  return [finishParse({...r, file:name, name:stem(name)})];
}
function finishParse(r){
  if (!r.fils.length && r.grams) r.fils = [{grams:r2(r.grams), type:r.type.split(' + ')[0] || '', hex:''}];
  r.tooMany = r.fils.length > MAXF ? r.fils.length : 0; r.fils = r.fils.slice(0, MAXF);
  if (r.grams === null && r.seconds === null) throw new Error('Não encontrei o peso nem o tempo neste ficheiro. Exporte o G-code do slicer (PrusaSlicer, OrcaSlicer, Bambu Studio, Cura ou Simplify3D) sem pós-processamento que remova os comentários.');
  return {...r, grams: r2(r.grams || 0), hours: r2((r.seconds || 0) / 3600), missing: r.grams === null ? 'peso' : r.seconds === null ? 'tempo' : ''};
}
function matchMat(type, grams){
  const mo = matOptions(), T = (type || '').toUpperCase(), mats = Object.keys(settings().matPrices);
  const base = T && (mats.find(m => m.toUpperCase() === T) || mats.find(m => T.startsWith(m.toUpperCase())) || mats.find(m => T.includes(m.toUpperCase())));
  if (base){
    const sp = S.spools.filter(s => s.material === base && spoolRemain(s) >= grams).sort((a, b) => spoolRemain(b) - spoolRemain(a))[0];
    return sp ? 's:' + sp.id : 'm:' + base;
  }
  return mo[0] ? mo[0][0] : '';
}
const srcLine = r => [r.slicer || 'Slicer desconhecido', r.type, r.layer ? `camada ${num(+r.layer, 2)} mm` : '', r.nozzle ? `bico ${num(+r.nozzle, 1)} mm` : ''].filter(Boolean).join(' · ');
async function readGcodeInto(files, onEach){
  const log = $('#g-log');
  for (const f of files){
    const li = document.createElement('li'); li.textContent = `A ler ${f.name}…`; log && log.append(li);
    try{
      const res = await parseFile(f);
      res.forEach(onEach);
      li.className = res.some(r => r.missing || r.estimated || r.tooMany) ? 'warn' : 'ok';
      li.innerHTML = res.map(r => `<b>${esc(r.name)}</b> — ${r.fils.length > 1 ? `${r.fils.length} filamentos ${r.fils.map(f => swatch(f.hex)).join('')} · ` : ''}${num(r.grams, 1)} g${r.estimated ? ' (calculado pelo comprimento do filamento)' : ''} · ${hm(r.hours)}${r.missing ? ` · <b>falta o ${r.missing}, preencha à mão</b>` : ''}${r.tooMany ? ` · <b>o ficheiro tem ${r.tooMany} filamentos; ficaram os primeiros ${MAXF}</b>` : ''}`).join('<br>');
    }catch(err){ li.className = 'bad'; li.textContent = `${f.name}: ${err && err.message ? err.message : 'não foi possível ler o ficheiro.'}`; }
  }
  onInput && onInput();
}
const dropZone = (multi, hint) => `<div class="drop" id="g-drop"><div class="txt"><b>Arraste o G-code para aqui</b><small>${hint}</small></div>
  <label class="btn sm file-btn">Escolher ficheiro${multi ? 's' : ''}<input type="file" id="g-file" ${multi ? 'multiple' : ''} accept=".gcode,.gco,.g,.3mf,.bgcode"></label><ul class="glog" id="g-log"></ul></div>`;

function nextQuoteNumber(){
  const y = today().slice(0, 4), n = S.quotes.filter(q => (q.number || '').startsWith(`ORC-${y}-`)).map(q => +q.number.split('-')[2] || 0);
  return `ORC-${y}-${String((n.length ? Math.max(...n) : 0) + 1).padStart(3, '0')}`;
}
function matOptions(){
  const sp = S.spools.filter(s => spoolRemain(s) > 0).map(s => ['s:' + s.id, `${spoolLabel(s)} · ${eur(spoolEurKg(s))}/kg`]);
  const gen = Object.entries(settings().matPrices).map(([k, v]) => ['m:' + k, `${k} genérico · ${eur(v)}/kg`]);
  return sp.concat(gen);
}
const genericOptions = () => Object.entries(settings().matPrices).map(([k, v]) => ['m:' + k, `${k} · ${eur(v)}/kg`]);
function matchType(type){
  const T = (type || '').toUpperCase(), mats = Object.keys(settings().matPrices);
  const base = T && (mats.find(m => m.toUpperCase() === T) || mats.find(m => T.startsWith(m.toUpperCase())) || mats.find(m => T.includes(m.toUpperCase())));
  return base ? 'm:' + base : 'm:' + (mats[0] || 'PLA');
}
const matType = code => !code ? '' : code.startsWith('m:') ? code.slice(2) : ((S.spools.find(s => s.id === code.slice(2)) || {}).material || '');
const hmInputs = (pre, hours, label = 'Tempo de impressão') => { const H = Math.floor(hours || 0), M = Math.round(((hours || 0) - H) * 60); return F(pre + '-h', `${label}: horas`, inp(pre + '-h', M === 60 ? H + 1 : H, 'number', 'min="0" step="1"')) + F(pre + '-m', 'minutos', inp(pre + '-m', M === 60 ? 0 : M, 'number', 'min="0" max="59" step="1"')); };
const readHM = pre => r2(numv(pre + '-h') + numv(pre + '-m') / 60);
const setHM = (pre, h) => { const H = Math.floor(h), M = Math.round((h - H) * 60); $('#' + pre + '-h').value = M === 60 ? H + 1 : H; $('#' + pre + '-m').value = M === 60 ? 0 : M; };
const thumbImg = (t, size = 40) => t ? `<img class="thumb" src="${esc(t)}" alt="" width="${size}" height="${size}">` : `<span class="thumb ph" style="width:${size}px;height:${size}px"></span>`;
const clientOpts = (extra = []) => extra.concat([...S.clients].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt')).map(c => [c.id, c.name + (c.nif ? ` · NIF ${c.nif}` : '')]));

/* ---------- editor de filamentos (peças, impressões planeadas e registos) ---------- */
// kind 'mat': material genérico ou bobine + gramas · kind 'spool': bobine a gastar + gramas
const FILED = {};
let filSeq = 0;
function filEditor(pre, fils, kind = 'mat'){
  FILED[pre] = {kind};
  return `<div class="fils" id="${pre}-fils">${fils.slice(0, MAXF).map((f, k) => filRow(pre, f, k)).join('')}</div>
    <div class="fils-foot"><button type="button" class="btn sm" data-act="fil-add" data-pre="${pre}">Adicionar filamento</button><span class="muted" id="${pre}-ftot"></span></div>`;
}
function filOpts(pre, f){
  if (FILED[pre].kind === 'spool'){
    const o = spoolOptsFor(f.mat || '', f.grams).map(x => x[0] === '' ? ['', 'Sem bobine (não desconta stock)'] : x);
    if (f.spoolId && !o.some(x => x[0] === f.spoolId)) o.push([f.spoolId, matLabel('s:' + f.spoolId)]);
    return o;
  }
  const o = genericOptions().concat(S.spools.map(x => ['s:' + x.id, `Bobine: ${spoolLabel(x)}`]));
  if (f.mat && !o.some(x => x[0] === f.mat)) o.unshift([f.mat, matLabel(f.mat)]);
  return o;
}
function filRow(pre, f, k){
  const key = 'f' + (++filSeq), spool = FILED[pre].kind === 'spool';
  const hex = spool ? (spoolHex(f.spoolId) || f.hex) : (matHex(f.mat) || f.hex);
  return `<div class="filrow" data-k="${key}" data-mat="${esc(f.mat || '')}" data-hex="${esc(f.hex || '')}">${swatch(hex)}<span class="fn num">${k + 1}</span>
    ${sel(`${pre}-fm-${key}`, filOpts(pre, f), spool ? (f.spoolId || '') : f.mat)}
    <input id="${pre}-fg-${key}" type="number" min="0" step="0.1" value="${esc(r2(f.grams))}" aria-label="Gramas do filamento ${k + 1}"><span class="u">g</span>
    <button type="button" class="btn ghost sm" data-act="fil-rm" aria-label="Remover filamento">✕</button></div>`;
}
function readFils(pre){
  const spool = (FILED[pre] || {}).kind === 'spool';
  return [...document.querySelectorAll(`#${pre}-fils .filrow`)].map(r => {
    const k = r.dataset.k, v = val(`${pre}-fm-${k}`), g = numv(`${pre}-fg-${k}`);
    if (spool){ const sp = S.spools.find(x => x.id === v); return {spoolId:v, mat:sp ? 's:' + sp.id : (r.dataset.mat || ''), grams:g, hex:sp ? sp.hex : (r.dataset.hex || '')}; }
    return {mat:v, grams:g, hex:matHex(v) || r.dataset.hex || ''};
  });
}
function setFils(pre, fils){ const box = $(`#${pre}-fils`); if (!box) return; box.innerHTML = fils.slice(0, MAXF).map((f, k) => filRow(pre, f, k)).join(''); filsUpdated(pre); }
function filsUpdated(pre){
  if (!FILED[pre]) return;
  const rows = [...document.querySelectorAll(`#${pre}-fils .filrow`)], spool = FILED[pre].kind === 'spool';
  rows.forEach((r, i) => {
    r.querySelector('.fn').textContent = i + 1;
    const v = val(`${pre}-fm-${r.dataset.k}`), hex = spool ? spoolHex(v) || r.dataset.hex : matHex(v) || r.dataset.hex;
    r.querySelector('.sw').style.background = hex || 'transparent';
  });
  const t = $(`#${pre}-ftot`); if (t) t.textContent = `${rows.length} ${rows.length === 1 ? 'filamento' : 'filamentos'} · total ${num(sumG(readFils(pre)), 1)} g${rows.length >= MAXF ? ` · máximo de ${MAXF}` : ''}`;
  const add = document.querySelector(`[data-act="fil-add"][data-pre="${pre}"]`); if (add) add.disabled = rows.length >= MAXF;
}
function filAdd(pre){
  const rows = document.querySelectorAll(`#${pre}-fils .filrow`); if (rows.length >= MAXF){ toast(`Cada peça pode ter no máximo ${MAXF} filamentos.`); return; }
  const last = readFils(pre).slice(-1)[0];
  const f = FILED[pre].kind === 'spool' ? {spoolId:'', mat:last ? last.mat : '', grams:0} : {mat:last ? last.mat : 'm:' + (Object.keys(settings().matPrices)[0] || 'PLA'), grams:0};
  const w = document.createElement('div'); w.innerHTML = filRow(pre, f, rows.length); $(`#${pre}-fils`).append(w.firstElementChild);
  filsUpdated(pre); onInput && onInput();
}
function filRm(btn){
  const box = btn.closest('.fils'), pre = box.id.replace(/-fils$/, '');
  if (box.querySelectorAll('.filrow').length <= 1){ toast('A peça precisa de pelo menos um filamento.'); return; }
  btn.closest('.filrow').remove(); filsUpdated(pre); onInput && onInput();
}
// filamentos lidos do G-code → material genérico (peças) ou bobine mais parecida (registos)
const gcodeFils = (r, kind, scale = 1) => (r.fils || []).map(f => {
  const mat = matchType(f.type), grams = r2(f.grams * scale);
  if (kind !== 'spool') return {mat, grams, hex:f.hex};
  const sp = bestSpool(mat.slice(2), f.hex, grams);
  return {spoolId:sp ? sp.id : '', mat:sp ? 's:' + sp.id : mat, grams, hex:f.hex};
});
// filamentos de uma peça → bobines sugeridas para imprimir qty unidades
const filsToSpools = (fils, qty = 1) => filsOf({fils}).map(f => {
  const grams = r2(f.grams * qty);
  if (f.mat && f.mat.startsWith('s:') && S.spools.some(s => s.id === f.mat.slice(2))) return {...f, grams, spoolId:f.mat.slice(2)};
  const sp = bestSpool(matType(f.mat), f.hex, grams);
  return {...f, grams, spoolId:sp ? sp.id : ''};
});

/* ---------- clientes ---------- */
function clientForm(c, after){
  const isNew = !c; c = c ? cp(c) : {id:uid(), name:'', nif:'', email:'', phone:'', address:'', notes:''};
  const qs = isNew ? [] : S.quotes.filter(q => q.clientId === c.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  openDlg(isNew ? 'Novo cliente' : 'Editar cliente', `
    <div class="row">${F('c-name', 'Nome / empresa', inp('c-name', c.name, 'text', 'required'))}${F('c-nif', 'NIF', inp('c-nif', c.nif, 'text', 'inputmode="numeric" maxlength="12"'))}</div>
    <div class="row">${F('c-email', 'Email', inp('c-email', c.email, 'email'))}${F('c-phone', 'Telefone', inp('c-phone', c.phone, 'tel'))}</div>
    ${F('c-address', 'Morada', `<textarea id="c-address">${esc(c.address)}</textarea>`)}
    ${F('c-notes', 'Notas', `<textarea id="c-notes">${esc(c.notes)}</textarea>`)}
    ${qs.length ? `<h3>Orçamentos deste cliente</h3><ul class="alerts">${qs.map(q => `<li><span class="pill ${(QSTATUS[q.status] || [])[1] || ''}">${(QSTATUS[q.status] || ['—'])[0]}</span><div class="txt">${esc(q.number)}<small>${fmtDate(q.date)}</small></div><b class="num">${eur(calcQuote(q).total)}</b></li>`).join('')}</ul>` : ''}`,
  {handler: async () => {
    if (!val('c-name').trim()){ toast('Indique o nome do cliente.'); return; }
    Object.assign(c, {name:val('c-name').trim(), nif:val('c-nif').trim(), email:val('c-email').trim(), phone:val('c-phone').trim(), address:val('c-address').trim(), notes:val('c-notes').trim()});
    await put('clients', c); closeDlg(); toast(isNew ? 'Cliente criado.' : 'Cliente atualizado.');
    if (after) after(c);
  }});
}

/* ---------- peças ---------- */
function partPrice(p){
  const s = settings();
  return calcQuote({printerId:(S.printers[0] || {}).id, failure:s.failure, margin:s.margin, laborRate:s.labor, items:[{...p, qty:1, disc:0}]}).net;
}
function partForm(p, opts = {}){
  const isNew = !p, s = settings();
  p = p ? cp(p) : {id:uid(), name:'', ref:'', clientId:opts.clientId || '', fils:[{mat:'m:' + (Object.keys(s.matPrices)[0] || 'PLA'), grams:0, hex:''}], hours:0, laborH:0, notes:'', src:null, thumb:''};
  const srcBox = () => p.src ? `${thumbImg(p.thumb, 56)}<span>Dados do ficheiro <b>${esc(p.src.file)}</b><br>${esc(srcLine(p.src))}${p.src.estimated ? ' · peso calculado pelo comprimento' : ''}</span>` : '';
  openDlg(isNew ? 'Nova peça' : 'Editar peça', `
    ${dropZone(false, 'Preenche o filamento, o tempo e o material a partir do ficheiro do slicer (.gcode ou .gcode.3mf).')}
    <div class="src-box" id="pt-src" ${p.src ? '' : 'hidden'}>${srcBox()}</div>
    <div class="row">${F('pt-name', 'Nome da peça', inp('pt-name', p.name, 'text', 'placeholder="ex.: Suporte de parede"'))}${F('pt-ref', 'Referência', inp('pt-ref', p.ref, 'text', 'placeholder="opcional"'))}${F('pt-client', 'Cliente', sel('pt-client', clientOpts([['', 'Geral (todos os clientes)']]), p.clientId))}</div>
    <div class="field"><label>Filamentos por unidade (até ${MAXF})</label>${filEditor('pt', filsOf(p), 'mat')}<span class="hint">Peças multicor ou multimaterial: um filamento por cor/material, com as gramas de cada um.</span></div>
    <div class="row">${hmInputs('pt', p.hours)}${F('pt-labor', 'Mão de obra por unidade (min)', inp('pt-labor', Math.round((p.laborH || 0) * 60), 'number', 'min="0" step="1"'))}</div>
    ${F('pt-notes', 'Notas', `<textarea id="pt-notes" placeholder="ex.: Imprimir deitada, com suportes">${esc(p.notes)}</textarea>`)}
    <p class="muted" style="margin:0">Preço de referência por unidade (margens das Definições, sem IVA): <b class="num" id="pt-price"></b></p>`,
  {input: () => { filsUpdated('pt'); $('#pt-price').textContent = eur(partPrice(readPart())); },
   handler: async () => {
    const n = readPart();
    if (!n.name){ toast('Indique o nome da peça.'); return; }
    await put('parts', n); closeDlg(); toast(isNew ? 'Peça criada.' : 'Peça atualizada.');
    if (opts.after) opts.after(n);
  }});
  function readPart(){ return withFils({...p, name:val('pt-name').trim(), ref:val('pt-ref').trim(), clientId:val('pt-client'), hours:readHM('pt'), laborH:r2(numv('pt-labor') / 60), notes:val('pt-notes').trim()}, readFils('pt').filter(f => f.mat)); }
  onGcode = r => {
    if (!val('pt-name').trim() || $('#pt-name').dataset.fromGcode){ $('#pt-name').value = r.name; $('#pt-name').dataset.fromGcode = '1'; }
    if (r.fils && r.fils.length) setFils('pt', gcodeFils(r, 'mat'));
    if (r.hours) setHM('pt', r.hours);
    p.src = {file:r.file, slicer:r.slicer, type:r.type, layer:r.layer, nozzle:r.nozzle, estimated:r.estimated}; p.thumb = r.thumb || '';
    const box = $('#pt-src'); box.innerHTML = srcBox(); box.hidden = false;
  };
}
function partFromGcode(r, clientId){
  return withFils({id:uid(), name:r.name, ref:'', clientId:clientId || '', hours:r.hours, laborH:0, notes:'',
    src:{file:r.file, slicer:r.slicer, type:r.type, layer:r.layer, nozzle:r.nozzle, estimated:r.estimated}, thumb:r.thumb || ''}, gcodeFils(r, 'mat'));
}
function importPartsDlg(){
  openDlg('Importar peças de G-code', `<p style="margin:0">Cada ficheiro (ou cada placa de um .gcode.3mf) é guardado como uma peça nova no catálogo. Depois pode editá-las para acertar o nome, o cliente e a mão de obra.</p>
    <div class="row">${F('imp-client', 'Associar ao cliente', sel('imp-client', clientOpts([['', 'Geral (todos os clientes)']]), ''))}</div>
    ${dropZone(true, 'Ficheiros .gcode ou .gcode.3mf do PrusaSlicer, OrcaSlicer, Bambu Studio, Cura ou Simplify3D.')}`,
  {submit:''});
  onGcode = async r => { try{ await put('parts', partFromGcode(r, val('imp-client'))); }catch(e){} };
}

/* ---------- orçamentos ---------- */
const clientName = o => (S.clients.find(c => c.id === o.clientId) || {}).name || o.client || '';
function quoteForm(q, opts = {}){
  const s = settings(), isNew = !q;
  q = q ? cp(q) : {id:uid(), number:nextQuoteNumber(), clientId:opts.clientId || '', client:'', date:today(), validity:15, deliveryDays:s.delivery, status:'rascunho', printerId:(S.printers[0] || {}).id || '', items:[], laborRate:s.labor, laborH:0, extras:0, failure:s.failure, margin:s.margin, vat:true, notes:''};
  if (q.laborRate == null || q.laborRate === '') q.laborRate = s.labor;
  // cópia fixa de cada peça no orçamento (para o valor não mudar sozinho se a peça for alterada)
  const snap = {}; (q.items || []).forEach(it => { snap[it.id] = cp(it); });
  quoteForm.snap = snap;
  const mo = matOptions();
  const ensureOpt = code => { if (code && !mo.some(o => o[0] === code)) mo.push([code, matLabel(code)]); };
  (q.items || []).forEach(it => filsOf(it).forEach(f => ensureOpt(f.mat)));
  const gramsSig = x => filsOf(x).map(f => r2(f.grams)).join('|');
  const isStale = it => { const p = it.partId && S.parts.find(x => x.id === it.partId); return p && (p.name !== it.desc || gramsSig(p) !== gramsSig(it) || +p.hours !== +it.hours || +(p.laborH || 0) !== +(it.laborH || 0)); };
  const optsHtml = (v) => mo.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const itemFils = it => { const fl = filsOf(it); return `<div class="field qi-mat${fl.length > 1 ? ' multi' : ''}"><label>${fl.length > 1 ? `Filamentos (${fl.length})` : 'Filamento'}</label><div class="qi-fils">${fl.map((f, k) => `<div class="qf">${swatch(matHex(f.mat) || f.hex)}<select id="i-m-${it.id}-${k}" aria-label="Filamento ${k + 1}">${optsHtml(f.mat)}</select>${fl.length > 1 ? `<span class="num muted">${num(f.grams, 1)} g</span>` : ''}</div>`).join('')}</div></div>`; };
  const itemRow = it => `<div class="qitem" data-id="${it.id}">
    <div class="qi-name">${thumbImg(it.thumb)}<div><b>${esc(it.desc || 'Peça')}</b>${it.ref ? ` <span class="muted mono">${esc(it.ref)}</span>` : ''}<small>${num(it.grams, 1)} g · ${hm(it.hours)}${it.laborH ? ` · ${num(it.laborH * 60)} min mão de obra` : ''} por unidade${it.partId ? '' : ' · sem ficha no catálogo'}</small>${isStale(it) ? `<button type="button" class="linkbtn" data-act="refresh-item">A peça foi alterada no catálogo. Atualizar</button>` : ''}</div></div>
    ${itemFils(it)}
    ${F('i-q-' + it.id, 'Qtd.', inp('i-q-' + it.id, it.qty || 1, 'number', 'min="1" step="1"'))}
    ${F('i-x-' + it.id, 'Desc. %', inp('i-x-' + it.id, it.disc || 0, 'number', 'min="0" max="100" step="0.5"'))}
    <div class="qi-price"><span class="u"></span><b class="t"></b></div>
    <button type="button" class="btn ghost" data-act="rm-row" aria-label="Remover peça">✕</button></div>`;
  // filamentos da peça; os genéricos passam para a bobine mais parecida (material e cor) com stock
  const partFils = (p, qty) => filsOf(p).map(f => { if (f.mat && f.mat.startsWith('m:')){ const sp = bestSpool(f.mat.slice(2), f.hex, f.grams * qty); if (sp) return {mat:'s:' + sp.id, grams:f.grams, hex:f.hex}; } return {mat:f.mat, grams:f.grams, hex:f.hex}; });
  const itemFromPart = (p, qty = 1) => withFils({id:uid(), partId:p.id, desc:p.name, ref:p.ref || '', hours:+p.hours || 0, laborH:+p.laborH || 0, thumb:p.thumb || '', qty, disc:0}, partFils(p, qty));
  const addItem = it => { filsOf(it).forEach(f => ensureOpt(f.mat)); snap[it.id] = it; const w = document.createElement('div'); w.innerHTML = itemRow(it); $('#q-items').append(w.firstElementChild); $('#q-empty').hidden = true; };
  quoteForm.addPart = (pid, qty) => { const p = S.parts.find(x => x.id === pid); if (p){ addItem(itemFromPart(p, qty)); onInput && onInput(); } };
  quoteForm.refreshItem = id => {
    const old = snap[id], p = old && S.parts.find(x => x.id === old.partId); if (!p) return;
    const qty = numv('i-q-' + id) || 1;
    const n = withFils({...old, desc:p.name, ref:p.ref || '', hours:+p.hours || 0, laborH:+p.laborH || 0, thumb:p.thumb || '', qty, disc:numv('i-x-' + id)}, partFils(p, qty));
    filsOf(n).forEach(f => ensureOpt(f.mat)); snap[id] = n; const row = document.querySelector(`.qitem[data-id="${id}"]`); const w = document.createElement('div'); w.innerHTML = itemRow(n); row.replaceWith(w.firstElementChild); onInput && onInput();
  };
  const partOpts = cid => {
    const mine = S.parts.filter(p => cid && p.clientId === cid), gen = S.parts.filter(p => !p.clientId), other = S.parts.filter(p => p.clientId && p.clientId !== cid);
    const o = list => list.sort((a, b) => a.name.localeCompare(b.name, 'pt')).map(p => `<option value="${p.id}">${esc(p.name)}${p.ref ? ' · ' + esc(p.ref) : ''} — ${filsOf(p).length > 1 ? filsOf(p).length + ' filamentos · ' : ''}${num(sumG(filsOf(p)), 1)} g · ${hm(p.hours)}</option>`).join('');
    return `<option value="">Escolher peça do catálogo…</option>${mine.length ? `<optgroup label="Deste cliente">${o(mine)}</optgroup>` : ''}${gen.length ? `<optgroup label="Gerais">${o(gen)}</optgroup>` : ''}${other.length ? `<optgroup label="De outros clientes">${o(other)}</optgroup>` : ''}`;
  };
  quoteForm.partOpts = partOpts;
  const read = () => {
    const cid = val('q-client');
    return {...q, number:val('q-number').trim(), clientId:cid === '__new' || cid === '__legacy' ? '' : cid, client:cid === '__new' ? val('qc-name').trim() : cid === '__legacy' ? q.client : clientName({clientId:cid}), date:val('q-date'), validity:numv('q-validity'), deliveryDays:Math.round(numv('q-delivery')), status:val('q-status'), printerId:val('q-printer'),
      laborRate:numv('q-rate'), laborH:numv('q-labor'), extras:numv('q-extras'), failure:numv('q-failure'), margin:numv('q-margin'), vat:$('#q-vat').checked, notes:val('q-notes').trim(),
      items:[...document.querySelectorAll('#q-items .qitem')].map(r => { const id = r.dataset.id; const fl = filsOf(snap[id]).map((f, k) => { const m = val(`i-m-${id}-${k}`) || f.mat; return {mat:m, grams:f.grams, hex:f.hex}; }); return withFils({...snap[id], id, qty:Math.max(1, Math.round(numv('i-q-' + id))), disc:Math.min(100, Math.max(0, numv('i-x-' + id)))}, fl); })};
  };
  quoteForm.read = read;
  quoteForm.save = () => onSubmit && onSubmit();
  let lastClient = q.clientId;
  openDlg(isNew ? 'Novo orçamento' : `Orçamento ${q.number}`, `<div class="q-grid"><div style="display:flex;flex-direction:column;gap:14px;min-width:0">
      <div class="row">${F('q-number', 'Número', inp('q-number', q.number))}${F('q-date', 'Data', inp('q-date', q.date, 'date'))}${F('q-validity', 'Validade (dias)', inp('q-validity', q.validity, 'number', 'min="1"'))}${F('q-delivery', 'Prazo de entrega (dias úteis)', inp('q-delivery', q.deliveryDays ?? s.delivery, 'number', 'min="0" step="1"') + '<span class="hint" id="q-delivery-h"></span>')}${F('q-status', 'Estado', sel('q-status', Object.entries(QSTATUS).map(([k, [l]]) => [k, l]), q.status))}</div>
      <div class="row">${F('q-client', 'Cliente', sel('q-client', clientOpts([['', 'Sem cliente']]).concat(q.clientId || !q.client ? [] : [['__legacy', q.client + ' (sem ficha)']]).concat([['__new', '+ Novo cliente…']]), q.clientId || (q.client ? '__legacy' : '')))}${F('q-printer', 'Impressora', sel('q-printer', S.printers.map(p => [p.id, p.name]).concat(S.printers.length ? [] : [['', 'Sem impressora']]), q.printerId))}</div>
      <div class="newclient" id="q-newclient" hidden><div class="row">${F('qc-name', 'Nome do novo cliente', inp('qc-name'))}${F('qc-nif', 'NIF', inp('qc-nif'))}${F('qc-email', 'Email', inp('qc-email', '', 'email'))}${F('qc-phone', 'Telefone', inp('qc-phone', '', 'tel'))}</div><span class="hint muted">O cliente é guardado na base de dados quando gravar o orçamento.</span></div>
      <h3>Peças</h3>
      <div class="addpart"><select id="q-addpart" aria-label="Peça do catálogo">${partOpts(q.clientId)}</select><input id="q-addqty" type="number" min="1" step="1" value="1" aria-label="Quantidade" style="width:76px"><button type="button" class="btn" data-act="add-part">Adicionar</button></div>
      <details class="gimport"><summary>Importar G-code como peça nova</summary>${dropZone(true, 'Cada ficheiro (ou placa) é guardado no catálogo de peças e adicionado a este orçamento.')}</details>
      <div class="items" id="q-items">${(q.items || []).map(itemRow).join('')}</div>
      <div class="empty" id="q-empty" ${(q.items || []).length ? 'hidden' : ''}>Escolha peças do catálogo para montar o orçamento.</div>
      <div class="row">${F('q-rate', 'Mão de obra (€/hora)', inp('q-rate', q.laborRate, 'number', 'min="0" step="0.5"'))}${F('q-labor', 'Mão de obra adicional (h)', inp('q-labor', q.laborH || 0, 'number', 'min="0" step="0.25"'))}${F('q-extras', 'Extras (€)', inp('q-extras', q.extras, 'number', 'min="0" step="0.01"'))}</div>
      <div class="row">${F('q-failure', 'Margem p/ falhas (%)', inp('q-failure', q.failure, 'number', 'min="0" step="1"'))}${F('q-margin', 'Margem de lucro (%)', inp('q-margin', q.margin, 'number', 'min="0" step="1"'))}</div>
      <label class="check"><input type="checkbox" id="q-vat" ${q.vat ? 'checked' : ''}> Incluir IVA (${num(s.vat)}%)</label>
      ${F('q-notes', 'Notas para o cliente', `<textarea id="q-notes" placeholder="ex.: Inclui pintura; portes por conta do cliente">${esc(q.notes)}</textarea>`)}
    </div><aside class="sum" id="q-sum"></aside></div>`,
  {wide:true, extra: `<div class="actions">${isNew ? '' : `<button type="button" class="btn danger" data-act="del" data-col="quotes" data-id="${q.id}">Eliminar</button>`}<button type="button" class="btn" data-act="copy-quote">Copiar resumo</button><button type="button" class="btn" data-act="quote-pdf">Gerar PDF</button>${orderOf(q) ? `<button type="button" class="btn" data-act="edit-order" data-id="${orderOf(q).id}">Ver encomenda ${esc(orderOf(q).number)}</button>` : (q.status === 'recusado' ? '' : `<button type="button" class="btn" data-act="convert-current">Aceite: converter em encomenda</button>`)}</div>`,
   input: () => {
    const cid = val('q-client');
    $('#q-newclient').hidden = cid !== '__new';
    const dd = Math.round(numv('q-delivery')); $('#q-delivery-h').textContent = dd ? `Se aceite hoje: ${fmtDate(addBusinessDays(today(), dd))}` : '';
    if (cid !== lastClient){ lastClient = cid; $('#q-addpart').innerHTML = partOpts(cid === '__new' || cid === '__legacy' ? '' : cid); }
    document.querySelectorAll('#q-items .qf').forEach(qf => { const sw = qf.querySelector('.sw'); if (sw) sw.style.background = matHex(qf.querySelector('select').value) || sw.style.background; });
    const n = read(), c = calcQuote(n), L = (l, v, cls = '') => `<div class="l ${cls}"><span>${l}</span><span>${v}</span></div>`;
    [...document.querySelectorAll('#q-items .qitem')].forEach((r, i) => { const l = c.lines[i]; if (!l) return; r.querySelector('.u').textContent = `${eur(l.unitPrice)} /un.`; r.querySelector('.t').textContent = eur(l.net); r.querySelector('.t').title = l.disc ? `Antes do desconto: ${eur(l.gross)}` : ''; });
    $('#q-empty').hidden = n.items.length > 0;
    $('#q-sum').innerHTML = `<div class="eyebrow">Cálculo</div>${L('Filamento', eur(c.material))}${L(`${num(c.grams)} g · ${hm(c.hours)} de máquina`, '', 'sub')}${L('Energia', eur(c.energy))}${L('Desgaste da máquina', eur(c.machine))}${L(`Mão de obra (${eur(c.rate)}/h)`, eur(c.labor))}${L('Margem p/ falhas', eur(c.failure))}${L('Extras', eur(c.extras))}<hr>${L('Custo total', eur(c.cost))}${L('Preço antes de descontos', eur(c.gross))}${c.discount ? L('Descontos', '−' + eur(c.discount), 'disc') : ''}${L('Valor sem IVA', eur(c.net))}${L('Lucro', eur(c.profit), c.profit < 0 ? 'neg' : 'sub')}${L(`IVA (${num(s.vat)}%)`, eur(c.vat))}<hr>${L('Total', eur(c.total), 'total')}`;
   },
   handler: async () => {
    const n = read();
    if (!n.number){ toast('Indique o número do orçamento.'); return; }
    if (val('q-client') === '__new'){
      if (!val('qc-name').trim()){ toast('Indique o nome do novo cliente.'); return; }
      const c = {id:uid(), name:val('qc-name').trim(), nif:val('qc-nif').trim(), email:val('qc-email').trim(), phone:val('qc-phone').trim(), address:'', notes:''};
      await put('clients', c); n.clientId = c.id; n.client = c.name;
    }
    if (JSON.stringify(n).length > 200000) n.items.forEach(it => { delete it.thumb; });
    await put('quotes', n); closeDlg(); toast('Orçamento guardado.');
    return n;
   }});
  onGcode = async r => {
    const cid = val('q-client'), p = partFromGcode(r, cid && !cid.startsWith('__') ? cid : '');
    try{ await put('parts', p); }catch(e){ return; }
    addItem(itemFromPart(p, 1)); onInput && onInput();
  };
  (opts.partIds || []).forEach(pid => { const p = S.parts.find(x => x.id === pid); if (p) addItem(itemFromPart(p, 1)); });
  onInput && onInput();
}
function quoteText(q){
  const c = calcQuote(q), s = settings(), cl = S.clients.find(x => x.id === q.clientId);
  const lines = [`${s.company} — Orçamento ${q.number}`, `Data: ${fmtDate(q.date)} · Válido por ${q.validity} dias`, +q.deliveryDays ? `Prazo de entrega: ${q.deliveryDays} dias úteis após aceitação` : '',
    clientName(q) ? `Cliente: ${clientName(q)}${cl && cl.nif ? ` (NIF ${cl.nif})` : ''}` : '', '',
    ...(q.items || []).map((it, i) => { const l = c.lines[i]; return `• ${it.desc || 'Peça'} — ${it.qty} un. × ${eur(l.unitPrice)}${l.disc ? ` − ${num(it.disc, 1)}% desconto` : ''} = ${eur(l.net)}`; }),
    c.extraLaborPrice ? `• Mão de obra adicional — ${eur(c.extraLaborPrice)}` : '', c.extras ? `• Extras — ${eur(c.extras)}` : '', '',
    c.discount ? `Desconto total: ${eur(c.discount)}` : '', `Valor sem IVA: ${eur(c.net)}`, q.vat ? `IVA (${s.vat}%): ${eur(c.vat)}` : '', `Total: ${eur(c.total)}`, q.notes ? '\n' + q.notes : ''];
  return lines.filter((l, i) => l !== '' || (i > 0 && lines[i - 1] !== '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- dados de exemplo (só ao clicar) ---------- */
async function loadSample(){
  const P1 = uid(), P2 = uid(), s1 = uid(), s2 = uid(), s3 = uid(), s4 = uid(), c1 = uid(), c2 = uid(), pa = uid(), pb = uid(), pc = uid();
  const t = (n, i, l) => ({id:uid(), name:n, interval:i, last:l});
  const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
  const rows = {
    printers:[{id:P1, name:'P1S nº1 (exemplo)', model:'Bambu Lab P1S', watts:110, price:650, life:6000, hours:842, status:'ativa', tasks:[t('Limpeza da base e bico', 50, 820), t('Lubrificação dos eixos', 200, 610), t('Verificar tensão das correias', 300, 600), t('Troca de bico', 500, 400)]},
      {id:P2, name:'Ender 3 V3 (exemplo)', model:'Creality Ender 3 V3', watts:150, price:300, life:4000, hours:1290, status:'ativa', tasks:[t('Limpeza da base e bico', 50, 1270), t('Lubrificação dos eixos', 200, 1100), t('Verificar tensão das correias', 300, 1000), t('Troca de bico', 500, 1000)]}],
    spools:[{id:s1, material:'PLA', color:'Preto mate (exemplo)', hex:'#232323', brand:'eSun', diameter:'1.75', weight:1000, remaining:640, tare:220, price:19.9, bought:d(20), location:'Caixa seca A'},
      {id:s2, material:'PETG', color:'Azul translúcido (exemplo)', hex:'#2F6FD0', brand:'Prusament', diameter:'1.75', weight:1000, remaining:120, tare:190, price:29.99, bought:d(45), location:'Caixa seca A'},
      {id:s3, material:'PLA', color:'Branco (exemplo)', hex:'#F4F4F2', brand:'Sunlu', diameter:'1.75', weight:1000, remaining:910, tare:160, price:17.5, bought:d(6), location:'Prateleira 2'},
      {id:s4, material:'TPU', color:'Vermelho (exemplo)', hex:'#C8322E', brand:'Polymaker', diameter:'1.75', weight:750, remaining:500, tare:180, price:32, bought:d(60), location:'Caixa seca B'}],
    clients:[{id:c1, name:'Atelier Silva (exemplo)', nif:'', email:'', phone:'', address:'', notes:''}, {id:c2, name:'Loja Ferragens (exemplo)', nif:'', email:'', phone:'', address:'', notes:''}],
    parts:[{id:pa, name:'Engrenagem helicoidal (exemplo)', ref:'ENG-01', clientId:c1, mat:'m:PLA', grams:48, hours:2.3, laborH:0.1, notes:'', src:null, thumb:''},
      {id:pb, name:'Suporte de parede (exemplo)', ref:'SUP-01', clientId:'', mat:'m:PLA', grams:28, hours:1.4, laborH:0.05, notes:'', src:null, thumb:''},
      withFils({id:pc, name:'Porta-chaves bicolor (exemplo)', ref:'PC-02', clientId:'', hours:0.8, laborH:0.05, notes:'Troca de cor com AMS', src:null, thumb:''}, [{mat:'m:PLA', grams:6.5, hex:'#232323'}, {mat:'m:PLA', grams:3.2, hex:'#F4F4F2'}, {mat:'m:PETG', grams:1.1, hex:'#2F6FD0'}])],
    jobs:[{id:uid(), date:d(1), name:'Suportes de parede x4 (exemplo)', clientId:c2, client:'Loja Ferragens (exemplo)', partId:pb, printerId:P1, spoolId:s1, grams:112, hours:5.5, result:'sucesso', reason:'', quoteId:'', notes:''},
      {id:uid(), date:d(3), name:'Caixa eletrónica (exemplo)', clientId:'', client:'', partId:'', printerId:P2, spoolId:s2, grams:86, hours:4.2, result:'falha', reason:'Warping', quoteId:'', notes:'Repetir com brim'}],
    maint:[{id:uid(), printerId:P1, taskId:'', task:'Limpeza da base e bico', date:d(5), hoursAt:820, cost:0, notes:'Exemplo'}],
    quotes:[{id:uid(), number:`ORC-${today().slice(0, 4)}-001`, clientId:c1, client:'Atelier Silva (exemplo)', date:d(2), validity:15, status:'enviado', printerId:P1, items:[{id:uid(), partId:pa, desc:'Engrenagem helicoidal (exemplo)', ref:'ENG-01', mat:'s:' + s3, grams:48, hours:2.3, laborH:0.1, thumb:'', qty:6, disc:5}], laborRate:15, laborH:0, extras:0, failure:10, margin:40, vat:true, notes:''}]
  };
  for (const [c, list] of Object.entries(rows)) for (const r of list) await put(c, r);
  toast('Dados de exemplo carregados.');
}

/* ---------- eventos ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  const find = (c) => S[c].find(x => x.id === id);
  try{
    switch (a){
      case 'close': closeDlg(); break;
      case 'filter': st[b.dataset.k] = b.dataset.k === 'gDays' ? +b.dataset.v : b.dataset.v; render(); break;
      case 'new-spool': spoolForm(); break;
      case 'edit-spool': spoolForm(find('spools')); break;
      case 'weigh': weighForm(find('spools')); break;
      case 'new-printer': printerForm(); break;
      case 'edit-printer': printerForm(find('printers')); break;
      case 'new-maint': maintForm(id); break;
      case 'new-job': jobForm(); break;
      case 'edit-job': jobForm(find('jobs')); break;
      case 'new-quote': quoteForm(); break;
      case 'edit-quote': quoteForm(find('quotes')); break;
      case 'sample': await loadSample(); break;
      case 'add-task': { const r = document.createElement('div'); r.innerHTML = printerForm.taskRow({id:uid(), name:'', interval:100, last:numv('p-hours')}); $('#task-rows').append(r.firstElementChild); break; }
      case 'add-part': { const pid = val('q-addpart'); if (!pid){ toast('Escolha uma peça do catálogo.'); break; } quoteForm.addPart(pid, Math.max(1, Math.round(numv('q-addqty')))); $('#q-addpart').value = ''; $('#q-addqty').value = 1; break; }
      case 'refresh-item': quoteForm.refreshItem(b.closest('.qitem').dataset.id); break;
      case 'convert': await convertQuote(find('quotes')); break;
      case 'convert-current': {
        if (val('q-client') === '__new'){ toast('Guarde primeiro o orçamento para criar o cliente.'); break; }
        const n = quoteForm.read(); if (!n.items.length){ toast('O orçamento não tem peças.'); break; }
        n.status = 'aceite'; await put('quotes', n); await convertQuote(n); break;
      }
      case 'edit-order': orderForm(find('orders')); break;
      case 'plan-order': { let o = find('orders'); if ($('#o-due') && orderForm.save) o = await orderForm.save(); planOrderDlg(o); break; }
      case 'new-plan': planForm(); break;
      case 'edit-plan': planForm(find('plan')); break;
      case 'plan-start': await startPlan(find('plan')); break;
      case 'plan-done': finishPlan(find('plan')); break;
      case 'compact': await compactQueue(id); break;
      case 'logout': await signOut(); break;
      case 'team-invite': case 'team-uninvite': case 'team-rm': await teamAction(a, id); break;
      case 'new-client': clientForm(); break;
      case 'edit-client': clientForm(find('clients')); break;
      case 'quote-client': quoteForm(null, {clientId:id}); break;
      case 'new-part': partForm(); break;
      case 'edit-part': partForm(find('parts')); break;
      case 'import-parts': importPartsDlg(); break;
      case 'quote-part': { const p = find('parts'); quoteForm(null, {clientId:p.clientId || '', partIds:[p.id]}); break; }
      case 'rm-row': b.closest('.qitem, .item, .task-row').remove(); onInput && onInput(); break;
      case 'fil-add': filAdd(b.dataset.pre); break;
      case 'fil-rm': filRm(b); break;
      case 'quote-pdf': {
        const n = quoteForm.read();
        if (val('q-client') === '__new') n._newClient = {name:val('qc-name').trim(), nif:val('qc-nif').trim(), email:val('qc-email').trim(), phone:val('qc-phone').trim()};
        await exportQuotePdf(n); break;
      }
      case 'quote-pdf-id': await exportQuotePdf(find('quotes')); break;
      case 'logo-rm': { st.logo = ''; const keep = {}; document.querySelectorAll('#settings-form input, #settings-form textarea').forEach(i => { if (i.id && i.type !== 'file') keep[i.id] = i.value; }); render(); Object.entries(keep).forEach(([k, v]) => { const el = document.getElementById(k); if (el) el.value = v; }); break; }
      case 'copy-quote': {
        const txt = quoteText(quoteForm.read());
        try{ await navigator.clipboard.writeText(txt); toast('Resumo copiado. Cole-o num email ou mensagem.'); }
        catch(err){ openDlg('Resumo do orçamento', `<textarea id="q-copy" style="width:100%;min-height:240px" class="mono">${esc(txt)}</textarea>`, {submit:''}); const t = $('#q-copy'); t.focus(); t.select(); }
        break;
      }
      case 'csv': {
        const jobs = jobsIn(st.month, st.repPrinter);
        const pn = i => (S.printers.find(p => p.id === i) || {}).name || '', sn = i => { const s = S.spools.find(x => x.id === i); return s ? spoolLabel(s) : ''; };
        const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = ['Data;Peça;Cliente;Impressora;Filamento;Gramas;Horas;Resultado;Motivo;Notas'].concat(jobs.map(j => [j.date, j.name, clientName(j), pn(j.printerId), usesOf(j).map(u => `${sn(u.spoolId) || 'Sem bobine'} (${String(r2(u.grams)).replace('.', ',')} g)`).join(' + '), String(r2(sumG(usesOf(j)))).replace('.', ','), String(j.hours).replace('.', ','), j.result, j.reason, j.notes].map(q).join(';'))).join('\r\n');
        try{ await downloads.save({filename:`impressoes-${st.month}.csv`, data:'﻿' + csv}); }catch(err){ if (err && err.code !== 'declined') toast('Não foi possível exportar o ficheiro.'); }
        break;
      }
      case 'del': {
        const col = b.dataset.col, item = find(col);
        const labels = {spools:'esta bobine', printers:'esta impressora', maint:'este registo de manutenção', jobs:'esta impressão', quotes:'este orçamento', clients:'este cliente', parts:'esta peça do catálogo', orders:'esta encomenda', plan:'esta impressão planeada'};
        const extra = col === 'jobs' ? ' O filamento volta a ser somado à bobine e as horas são retiradas da impressora.' : col === 'clients' ? ' Os orçamentos e peças deste cliente mantêm-se, mas deixam de estar ligados à ficha.' : col === 'parts' ? ' Os orçamentos que já a incluem não mudam.' : col === 'orders' ? ' As impressões ainda por fazer são retiradas do planeamento; as já registadas mantêm-se.' : '';
        confirmDlg('Eliminar', `Quer eliminar ${labels[col]}?${extra} Esta ação não pode ser desfeita.`, 'Eliminar', async () => {
          if (col === 'jobs' && item){ await applyJob(item, null); const pl = item.planId && S.plan.find(x => x.id === item.planId); if (pl){ const c = cp(pl); c.status = 'planeada'; delete c.jobId; await put('plan', c); } }
          if (col === 'orders') for (const x of S.plan.filter(x => x.orderId === id && activePlan(x))) await del('plan', x.id);
          await del(col, id); toast('Eliminado.');
        });
        break;
      }
    }
  }catch(err){ /* mensagem já mostrada */ }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('tr.click')) e.target.click(); });
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'dlg-form' && onSubmit){ try{ await onSubmit(); }catch(err){} }
  if (e.target.id === 'settings-form'){
    const s = settings(), mp = {};
    document.querySelectorAll('[data-mat]').forEach(i => mp[i.dataset.mat] = parseFloat(i.value) || 0);
    try{ await putSettings({...s, company:val('s-company').trim() || 'Oficina 3D', kwh:numv('s-kwh'), labor:numv('s-labor'), margin:numv('s-margin'), failure:numv('s-failure'), vat:numv('s-vat'), low:numv('s-low'), delivery:numv('s-delivery'), matPrices:mp, cNif:val('s-nif').trim(), cPhone:val('s-phone').trim(), cEmail:val('s-email').trim(), cWeb:val('s-web').trim(), cAddress:val('s-address').trim(), cIban:val('s-iban').trim(), pdfColor:val('s-color') || '#0A7470', cond:val('s-cond').trim(), logo:st.logo !== undefined ? st.logo : (s.logo || '')}); st.logo = undefined; toast('Definições guardadas.'); }catch(err){}
  }
});
document.addEventListener('input', e => {
  if (e.target.closest('#dlg') && onInput) onInput();
  if (e.target.id === 'f-month' && e.target.value){ st.month = e.target.value; render(); }
  if (e.target.id === 'f-part-q' || e.target.id === 'f-client-q'){
    const id = e.target.id, pos = e.target.selectionStart; st[id === 'f-part-q' ? 'partQ' : 'clientQ'] = e.target.value; render();
    const el = document.getElementById(id); if (el){ el.focus(); try{ el.setSelectionRange(pos, pos); }catch(x){} }
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'g-file' && onGcode && e.target.files.length){ const fs = [...e.target.files]; e.target.value = ''; readGcodeInto($('#g-drop').querySelector('input').multiple ? fs : fs.slice(0, 1), onGcode); }
  if (e.target.id === 'f-printer'){ st.repPrinter = e.target.value; render(); }
  if (e.target.id === 'f-part-client'){ st.partClient = e.target.value; render(); }
  if (e.target.id === 's-logo' && e.target.files[0]) readLogo(e.target.files[0]);
  if (e.target.id === 'm-printer'){ $('#m-task').innerHTML = maintForm.taskOpts(e.target.value).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join(''); const p = S.printers.find(x => x.id === e.target.value); $('#m-hours').value = p ? p.hours || 0 : 0; onInput && onInput(); }
});
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { const z = e.target.closest && e.target.closest('#g-drop'); if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')){ e.preventDefault(); if (z) z.classList.add('over'); } }));
document.addEventListener('dragleave', e => { const z = e.target.closest && e.target.closest('#g-drop'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('over'); });
document.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const z = e.target.closest && e.target.closest('#g-drop'); if (z) z.classList.remove('over');
  if (z && onGcode){ const fs = [...e.dataTransfer.files]; readGcodeInto(z.querySelector('input').multiple ? fs : fs.slice(0, 1), onGcode); }
});
$('#dlg').addEventListener('close', () => { onSubmit = onInput = onGcode = null; });

init();
