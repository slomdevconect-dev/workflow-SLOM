(() => {
'use strict';
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const getText = t => t.textContent.replace(/ /g, ' ');
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.filter(k => k != null));
  return e;
}

let CSRF = '', ME = null, pages = [], cur = null, blocks = [];
let dirty = false, saveT = null, showingTrash = false, edges = [], serverNow = 0, section = 'home';
const expanded = new Set(JSON.parse(store.get('expanded') || '[]'));

/* ---------- API ---------- */
async function api(a, { body, q = '', keepalive = false } = {}) {
  const r = await fetch(`api.php?a=${a}${q}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-CSRF': CSRF },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin', keepalive,
  });
  const j = await r.json().catch(() => ({ error: 'Resposta inválida do servidor' }));
  if (!r.ok) {
    if (r.status === 401 && ME) { ME = null; showAuth(false); }
    throw Object.assign(new Error(j.error || 'Erro'), { status: r.status, data: j });
  }
  return j;
}

/* ---------- icones ---------- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  graph: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.9 7.6-3.8M8.2 13.1l7.6 3.8"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.5a5 5 0 0 1 4.5 5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 8l3 3M17 6l2 2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>',
  chevL: '<path d="m15 6-6 6 6 6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
const svg = n => `<svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const ico = n => { const e = document.createElement('span'); e.className = 'ico'; e.innerHTML = svg(n); return e; };
document.querySelectorAll('[data-i]').forEach(e => { e.innerHTML = svg(e.dataset.i); });

/* ---------- icones da marca (assets/img/icons) ---------- */
const ICON_NAMES = ["home", "board", "planner", "calendar", "checklist", "layers", "database", "team", "settings", "search", "bell", "bookmark", "star", "tag", "folder", "folder-plus", "file", "document", "image", "video", "add", "edit", "trash", "share", "download", "upload", "link", "external", "code", "terminal", "git", "done", "target", "flag", "trophy", "chart", "pie", "hourglass", "timer", "timer-play", "moon", "sun", "filter", "sort", "list", "grid", "gantt", "kanban", "note", "idea", "book", "brain", "stack", "notebook", "pen", "chain", "folder-star", "lock", "shield", "cloud-sync", "cloud-up", "cloud-down", "globe", "dev"];
const IMG = 'assets/img/icons/';
const pic = (n, c = '') => h('img', { class: ('pi ' + c).trim(), src: IMG + n + '.png', alt: '', draggable: 'false' });
const pageIcon = ic => {
  const m = /^i:(\d+)$/.exec(ic || '');
  if (m && ICON_NAMES[+m[1]]) return pic(ICON_NAMES[+m[1]]);
  return ic || null;
};
const DARK_THEMES = ['dark', 'midnight', 'forest', 'sunset', 'amethyst'];
function syncThemeIcon() { const e = $('#themeIcon'); if (e) e.src = IMG + (DARK_THEMES.includes(root.dataset.theme) ? 'moon' : 'sun') + '.png'; }

/* ---------- aparencia: temas, tamanho da letra, menu retratil ---------- */
const root = document.documentElement;
const THEMES = [
  { id: 'light', n: 'Claro', bg: '#ffffff', fg: '#37352f', acc: '#2f6fed' },
  { id: 'dark', n: 'Escuro', bg: '#191919', fg: '#e6e4df', acc: '#5b94ff' },
  { id: 'midnight', n: 'Meia-noite', bg: '#0b1220', fg: '#dbe6ff', acc: '#4da3ff' },
  { id: 'forest', n: 'Floresta', bg: '#0f1a14', fg: '#dcefe2', acc: '#4cd08a' },
  { id: 'sunset', n: 'Pôr do sol', bg: '#1a1210', fg: '#f5e6df', acc: '#ff8a4c' },
  { id: 'amethyst', n: 'Ametista', bg: '#17121f', fg: '#ece4f7', acc: '#b388ff' },
  { id: 'paper', n: 'Papel', bg: '#f6f0e3', fg: '#3b3226', acc: '#b5651d' },
  { id: 'rose', n: 'Rosa', bg: '#fff7f9', fg: '#43303a', acc: '#e0457b' },
];
const SIZES = [{ n: 'Normal', v: 16 }, { n: 'Grande', v: 18 }, { n: 'Maior', v: 20 }, { n: 'Máximo', v: 22 }];
const applyTheme = id => { root.dataset.theme = id; store.set('theme', id); syncThemeIcon(); };
const curSize = () => +store.get('fs') || 18;
const applySize = v => { root.style.setProperty('--fs', v + 'px'); store.set('fs', String(v)); };
const saved = store.get('theme');
root.dataset.theme = THEMES.some(t => t.id === saved) ? saved : (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
applySize(curSize());
syncThemeIcon();

const appEl = $('#app');
function setCollapsed(v) {
  appEl.classList.toggle('collapsed', v);
  store.set('collapsed', v ? '1' : '0');
  const b = $('#collapseBtn');
  b.innerHTML = svg(v ? 'chevL' : 'chevR');
  b.title = b.ariaLabel = v ? 'Expandir menu' : 'Recolher menu';
}
$('#collapseBtn').onclick = () => setCollapsed(!appEl.classList.contains('collapsed'));
$('#searchBtn').onclick = () => { setCollapsed(false); appEl.classList.add('open'); $('#search').focus(); };
setCollapsed(store.get('collapsed') === '1');

$('#themeBtn').onclick = () => {
  const grid = h('div', { class: 'themes' }, ...THEMES.map(t => {
    const b = h('button', { type: 'button', class: 'theme' + (t.id === root.dataset.theme ? ' on' : '') },
      h('span', { class: 'sw', style: `background:${t.bg};border-color:${t.acc}` }, h('i', { style: `background:${t.acc}` }), h('i', { style: `background:${t.fg}` })), t.n);
    b.onclick = () => { applyTheme(t.id); grid.querySelectorAll('.theme').forEach(x => x.classList.toggle('on', x === b)); };
    return b;
  }));
  const seg = h('div', { class: 'seg' }, ...SIZES.map(f => {
    const b = h('button', { type: 'button', class: f.v === curSize() ? 'on' : '' }, f.n);
    b.onclick = () => { applySize(f.v); seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
    return b;
  }));
  dlg.replaceChildren(h('form', { method: 'dialog' }, h('h3', {}, 'Aparência'),
    h('b', { class: 'lbl' }, 'Tema'), grid, h('b', { class: 'lbl' }, 'Tamanho da letra'), seg,
    h('div', { class: 'row2' }, h('button', { class: 'btn primary', value: 'ok' }, 'Pronto'))));
  dlg.onclose = null; dlg.showModal();
};

/* ---------- autenticação ---------- */
const MODES = {
  login:    { title: 'Entrar', btn: 'Entrar', fields: ['email', 'pass'], msg: 'Entre para acessar suas páginas.' },
  register: { title: 'Criar conta', btn: 'Criar conta', fields: ['name', 'email', 'pass', 'pass2'], msg: 'Enviaremos um e-mail para confirmar seu endereço.' },
  setup:    { title: 'Configuração inicial', btn: 'Criar administrador', fields: ['name', 'email', 'pass', 'pass2'], msg: 'Primeiro acesso: crie a conta de administrador.' },
  forgot:   { title: 'Recuperar senha', btn: 'Enviar link', fields: ['email'], msg: 'Informe seu e-mail para receber o link de redefinição.' },
  reset:    { title: 'Nova senha', btn: 'Salvar nova senha', fields: ['pass', 'pass2'], msg: 'Escolha uma nova senha (mínimo 8 caracteres).' },
  notice:   { title: '', btn: 'Voltar ao login', fields: [], msg: '' },
};
let mode = 'login', SIGNUP = true, resetToken = '', noticeEmail = '';
const field = n => document.querySelector(`#authForm [data-f="${n}"]`);
function setMode(m, msg, err) {
  mode = m;
  const c = MODES[m];
  ['name', 'email', 'pass', 'pass2'].forEach(n => {
    const on = c.fields.includes(n);
    field(n).hidden = !on;
    field(n).querySelector('input').required = on;
  });
  $('#aEmail').type = m === 'login' ? 'text' : 'email';
  $('#aEmail').previousSibling.textContent = m === 'login' ? 'E-mail ou usuário' : 'E-mail';
  $('#aPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('#authTitle').textContent = c.title;
  $('#authMsg').textContent = msg ?? c.msg;
  $('#authErr').textContent = err || '';
  $('#authBtn').textContent = c.btn;
  $('#resendBtn').hidden = !(m === 'notice' && noticeEmail);
  $('#lnkForgot').hidden = m !== 'login';
  const sw = $('#lnkSwitch');
  sw.hidden = m === 'setup' || (m === 'login' && !SIGNUP);
  sw.textContent = m === 'login' ? 'Criar conta' : 'Voltar ao login';
  sw.onclick = () => { noticeEmail = ''; setMode(m === 'login' ? 'register' : 'login'); };
  $('#aPass').value = $('#aPass2').value = '';
  const first = c.fields[0] && field(c.fields[0]).querySelector('input');
  if (first) first.focus();
}
function showAuth(setup) {
  $('#app').hidden = true; $('#auth').hidden = false;
  noticeEmail = '';
  setMode(setup ? 'setup' : 'login');
}
function notice(title, msg, email = '') {
  noticeEmail = email;
  setMode('notice', msg);
  $('#authTitle').textContent = title;
}
$('#lnkForgot').onclick = () => setMode('forgot', null);
$('#resendBtn').onclick = async () => {
  try { await api('resend', { body: { email: noticeEmail } }); $('#authErr').textContent = ''; $('#authMsg').textContent = 'Se houver uma conta pendente, enviamos um novo link para ' + noticeEmail + '.'; }
  catch (ex) { $('#authErr').textContent = ex.message; }
};
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#authErr'), btn = $('#authBtn');
  err.textContent = '';
  if (mode === 'notice') return setMode('login');
  const email = $('#aEmail').value.trim(), pass = $('#aPass').value;
  if (['register', 'setup', 'reset'].includes(mode) && pass !== $('#aPass2').value) { err.textContent = 'As senhas não conferem'; return; }
  btn.disabled = true;
  try {
    if (mode === 'login') {
      const r = await api('login', { body: { identifier: email, password: pass } });
      CSRF = r.csrf; ME = r.user; await startApp();
    } else if (mode === 'setup') {
      const r = await api('setup', { body: { name: $('#aName').value, email, password: pass } });
      CSRF = r.csrf; ME = r.user; await startApp();
    } else if (mode === 'register') {
      await api('register', { body: { name: $('#aName').value, email, password: pass } });
      notice('Verifique seu e-mail', `Enviamos um link de confirmação para ${email}. Clique nele para ativar a conta. Se não chegar em alguns minutos, olhe a caixa de spam.`, email);
    } else if (mode === 'forgot') {
      await api('forgot', { body: { email } });
      notice('Verifique seu e-mail', `Se existir uma conta com ${email}, enviamos um link para redefinir a senha. Ele vale por 1 hora.`);
    } else if (mode === 'reset') {
      await api('reset', { body: { token: resetToken, password: pass } });
      resetToken = ''; setMode('login', 'Senha alterada! Entre com a nova senha.');
    }
  } catch (ex) {
    if (ex.data && ex.data.unverified) notice('Confirme seu e-mail', ex.message, ex.data.email);
    else err.textContent = ex.message;
  }
  btn.disabled = false;
});
$('#logoutBtn').onclick = async () => {
  await flush();
  try { await api('logout', { body: {} }); } catch {}
  ME = null; cur = null; pages = []; location.hash = '';
  const r = await api('me'); CSRF = r.csrf; SIGNUP = r.signup;
  showAuth(r.setup);
};
function updateBanner() { $('#banner').hidden = !ME || !!ME.email_verified; }
async function emailDialog() {
  const v = await ask('E-mail da conta', [
    { name: 'email', label: 'Seu e-mail', type: 'email', value: ME.email || '', autocomplete: 'email', required: true },
    { name: 'password', label: 'Senha atual', type: 'password', autocomplete: 'current-password', required: true },
  ], 'Enviar link', 'Enviaremos um link de confirmação para este endereço.');
  if (!v) return;
  try { await api('email_set', { body: v }); toast('Link enviado. Verifique sua caixa de entrada.'); } catch (ex) { toast(ex.message); }
}
$('#bannerBtn').onclick = emailDialog;
$('#mailBtn').onclick = emailDialog;

/* ---------- app ---------- */
async function startApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#meName').textContent = ME.name;
  updateBanner(); renderTabs();
  if (ME.is_admin) return go('admin');
  await loadPages(); await loadLinks();
  if (!pages.some(p => !p.trashed)) {
    const r = await api('page_create', { body: { title: 'Primeiros passos', icon: 'i:49', content: WELCOME() } });
    pages.push(r.page);
  }
  const hs = location.hash.slice(1), note = /^p(\d+)$/.exec(hs);
  if (note) {
    const p = pages.find(x => x.id === +note[1] && !x.trashed);
    if (p) { await openPage(p.id, false); return; }
  }
  await go(SECTIONS.some(x => x.id === hs && !x.admin) ? hs : 'home');
}
async function loadLinks() { try { edges = (await api('links')).edges; } catch {} }
async function loadPages() {
  const pr = await api('pages');
  pages = pr.pages; serverNow = pr.now;
  renderTree();
}
const WELCOME = () => [
  { id: uid(), t: 'p', x: 'Este é o seu espaço. Cada página é feita de blocos.' },
  { id: uid(), t: 'h2', x: 'Como usar' },
  { id: uid(), t: 'ul', x: 'Digite / em uma linha vazia para escolher o tipo de bloco.' },
  { id: uid(), t: 'ul', x: 'Atalhos: "# " título, "- " lista, "1. " numerada, "[] " tarefa, "> " citação.' },
  { id: uid(), t: 'ul', x: 'Alt + ↑ / ↓ move o bloco. Ctrl + S salva agora.' },
  { id: uid(), t: 'ul', x: 'Conecte ideias digitando [[ e escolhendo uma página. Veja tudo no Grafo de ideias.' },
  { id: uid(), t: 'ul', x: 'Arraste páginas na barra lateral para aninhá-las.' },
  { id: uid(), t: 'todo', x: 'Criar minha primeira página', c: false },
  { id: uid(), t: 'todo', x: 'Conhecer o editor', c: true },
];

/* ---------- barra lateral ---------- */
function renderTree() {
  const tree = $('#tree'), q = $('#search').value.trim().toLowerCase();
  tree.textContent = '';
  const live = pages.filter(p => !p.trashed);
  if (q) {
    live.filter(p => (p.title || 'sem título').toLowerCase().includes(q)).forEach(p => tree.append(row(p, 0)));
    return;
  }
  const kids = pid => live.filter(p => p.parent_id === pid).sort((a, b) => a.position - b.position || a.id - b.id);
  const walk = (pid, d) => kids(pid).forEach(p => {
    tree.append(row(p, d));
    if (expanded.has(p.id)) walk(p.id, d + 1);
  });
  walk(null, 0);
  if (!tree.children.length) tree.append(h('div', { class: 'muted', style: 'padding:10px;font-size:14px' }, 'Nenhuma página.'));
}
function row(p, depth) {
  const hasKids = pages.some(x => x.parent_id === p.id && !x.trashed);
  const r = h('div', { class: 'row' + (cur && cur.id === p.id ? ' on' : ''), draggable: true, style: `padding-left:${4 + depth * 16}px` },
    h('button', { class: 'tw', title: 'Expandir', onclick: ev => { ev.stopPropagation(); toggle(p.id); } }, hasKids ? ico(expanded.has(p.id) ? 'chevD' : 'chevR') : null),
    h('span', { class: 'ic' }, pageIcon(p.icon) || pic('file')),
    h('span', { class: 'tt' }, p.title || 'Sem título'),
    h('span', { class: 'acts' },
      h('button', { title: 'Nova subpágina', onclick: ev => { ev.stopPropagation(); createPage(p.id); } }, pic('add')),
      h('button', { title: 'Mover para a lixeira', onclick: ev => { ev.stopPropagation(); trashPage(p.id); } }, pic('trash'))));
  r.onclick = () => openPage(p.id);
  r.ondragstart = ev => { ev.dataTransfer.setData('text/plain', String(p.id)); ev.dataTransfer.effectAllowed = 'move'; };
  r.ondragover = ev => { ev.preventDefault(); r.classList.add('over'); };
  r.ondragleave = () => r.classList.remove('over');
  r.ondrop = ev => { ev.preventDefault(); ev.stopPropagation(); r.classList.remove('over'); movePage(+ev.dataTransfer.getData('text/plain'), p.id); };
  return r;
}
$('#tree').ondragover = ev => ev.preventDefault();
$('#tree').ondrop = ev => { ev.preventDefault(); movePage(+ev.dataTransfer.getData('text/plain'), null); };
function toggle(id) {
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  store.set('expanded', JSON.stringify([...expanded]));
  renderTree();
}
async function movePage(id, parent) {
  const p = pages.find(x => x.id === id);
  if (!p || id === parent || p.parent_id === parent) return;
  try {
    await api('page_save', { body: { id, parent_id: parent } });
    if (parent !== null) { expanded.add(parent); store.set('expanded', JSON.stringify([...expanded])); }
    await loadPages();
    if (cur) renderCrumbs();
  } catch (ex) { toast(ex.message); }
}
async function createPage(parent) {
  await flush();
  try {
    const r = await api('page_create', { body: { parent_id: parent } });
    pages.push(r.page);
    if (parent !== null) { expanded.add(parent); store.set('expanded', JSON.stringify([...expanded])); }
    await openPage(r.page.id);
    $('.title')?.focus();
  } catch (ex) { toast(ex.message); }
}
async function trashPage(id) {
  await flush();
  try {
    await api('page_trash', { body: { id } });
    await loadPages();
    if (cur && pages.find(p => p.id === cur.id)?.trashed) {
      const next = pages.find(p => !p.trashed);
      next ? await openPage(next.id) : (cur = null, renderHome());
    }
  } catch (ex) { toast(ex.message); }
}
$('#newRoot').onclick = () => createPage(null);
function pickIcon() {
  const choose = v => { cur.icon = v; touch(); syncMeta(); renderPage(); dlg.close(); };
  const grid = h('div', { class: 'icongrid' }, ...ICON_NAMES.map((n, i) => h('button', { type: 'button', title: n, onclick: () => choose('i:' + i) }, pic(n))));
  const em = h('input', { placeholder: 'ou digite um emoji e tecle Enter', maxlength: 8 });
  em.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); choose(em.value.trim()); } };
  dlg.replaceChildren(h('form', { method: 'dialog' }, h('h3', {}, 'Ícone da página'), grid, em,
    h('div', { class: 'row2' }, h('button', { type: 'button', class: 'btn', onclick: () => choose('') }, 'Remover ícone'), h('button', { class: 'btn primary', value: 'cancel' }, 'Fechar'))));
  dlg.onclose = null; dlg.showModal();
}
$('#search').oninput = renderTree;
$('#menuBtn').onclick = () => $('#app').classList.toggle('open');
$('#scrim').onclick = () => $('#app').classList.remove('open');

/* ---------- página ---------- */
async function openPage(id, pushHash = true) {
  await flush();
  setSection('notes');
  try {
    const { page } = await api('page', { q: '&id=' + id });
    cur = page; showingTrash = false;
    try { blocks = JSON.parse(page.content); } catch { blocks = []; }
    if (!Array.isArray(blocks)) blocks = [];
    blocks.forEach(b => { b.id ||= uid(); });
    for (let a = pages.find(p => p.id === page.parent_id); a; a = pages.find(p => p.id === a.parent_id)) expanded.add(a.id);
    store.set('last', String(id));
    if (pushHash) history.replaceState(null, '', '#p' + id);
    renderPage(); renderTree(); renderCrumbs();
    $('#app').classList.remove('open');
  } catch (ex) { toast(ex.message); }
}
function renderCrumbs() {
  const c = $('#crumbs'); c.textContent = '';
  if (showingTrash) { c.textContent = 'Lixeira'; return; }
  if (!cur) return;
  const chain = [];
  for (let p = pages.find(x => x.id === cur.id); p; p = pages.find(x => x.id === p.parent_id)) chain.unshift(p);
  chain.forEach((p, i) => {
    if (i) c.append(' / ');
    const label = [pageIcon(p.icon), ' ', p.title || 'Sem título'];
    c.append(i < chain.length - 1 ? h('a', { onclick: () => openPage(p.id) }, ...label) : h('span', {}, ...label));
  });
}
function renderHome() {
  showingTrash = false; renderCrumbs(); renderTree();
  setView(h('div', { class: 'empty-view' }, pic('folder-plus', 'xl'), h('h2', {}, 'Nenhuma página aberta'),
    h('button', { class: 'btn primary', onclick: () => createPage(null) }, 'Criar página')));
}
function renderPage() {
  const icon = h('div', { class: 'page-ic' + (cur.icon ? '' : ' empty'), title: 'Alterar ícone', onclick: pickIcon }, pageIcon(cur.icon) || '＋ Ícone');
  const title = h('input', { class: 'title', placeholder: 'Sem título', value: cur.title, maxlength: 200, 'aria-label': 'Título' });
  title.oninput = () => { cur.title = title.value; syncMeta(); touch(); };
  title.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); if (!blocks.length) blocks.push(newBlock()); focusBlock(blocks[0].id, 0); }
  };
  if (!blocks.length) blocks.push(newBlock());
  const hint = h('div', { class: 'hint', onclick: () => {
    const last = blocks[blocks.length - 1];
    if (last.t === 'p' && !last.x) return focusBlock(last.id, -1);
    const b = newBlock(); blocks.push(b); renderEditor(b.id, 0); touch();
  } }, 'Clique aqui para adicionar um bloco · digite / para ver as opções');
  setView(h('div', { class: 'doc' }, icon, title, h('div', { id: 'editor' }), hint, h('div', { id: 'refs', class: 'refs' })));
  renderEditor(); renderRefs();
  setStatus('');
}
function syncMeta() {
  const p = pages.find(x => x.id === cur.id);
  if (p) { p.title = cur.title; p.icon = cur.icon; }
  renderTree(); renderCrumbs();
}

/* ---------- salvamento ---------- */
function setView(...nodes) { const v = $('#view'); v.classList.remove('flat'); v.replaceChildren(...nodes); }
const STATUS_ICON = { 'Salvo': 'done', 'Salvando…': 'cloud-sync', 'Erro ao salvar': 'flag' };
function setStatus(s) { $('#status').replaceChildren(...(STATUS_ICON[s] ? [pic(STATUS_ICON[s], 'sm')] : []), s); }
function touch() {
  dirty = true; setStatus('Editando…');
  clearTimeout(saveT); saveT = setTimeout(flush, 700);
}
async function flush(keepalive = false) {
  clearTimeout(saveT);
  if (!dirty || !cur) return;
  dirty = false; setStatus('Salvando…');
  try {
    await api('page_save', { body: { id: cur.id, title: cur.title, icon: cur.icon, content: blocks }, keepalive });
    setStatus('Salvo'); loadLinks().then(renderRefs);
  } catch (ex) { dirty = true; setStatus('Erro ao salvar'); toast(ex.message); }
}
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(true); });
addEventListener('pagehide', () => flush(true));

/* ---------- editor de blocos ---------- */
const newBlock = (t = 'p', x = '') => ({ id: uid(), t, x, ...(t === 'todo' ? { c: false } : {}) });
const TYPES = [
  { k: 'p', ic: 'document', g: '¶', n: 'Texto', d: 'Parágrafo simples', kw: 'texto paragrafo text' },
  { k: 'h1', g: 'H1', n: 'Título 1', d: 'Título grande', kw: 'titulo heading h1' },
  { k: 'h2', g: 'H2', n: 'Título 2', d: 'Título médio', kw: 'titulo heading h2' },
  { k: 'h3', g: 'H3', n: 'Título 3', d: 'Título pequeno', kw: 'titulo heading h3' },
  { k: 'todo', ic: 'checklist', g: '☑', n: 'Tarefa', d: 'Lista de tarefas', kw: 'todo tarefa checkbox' },
  { k: 'ul', ic: 'list', g: '•', n: 'Lista', d: 'Lista com marcadores', kw: 'lista bullet' },
  { k: 'ol', g: '1.', n: 'Lista numerada', d: 'Lista em ordem', kw: 'lista numerada number' },
  { k: 'quote', ic: 'note', g: '❝', n: 'Citação', d: 'Destaque de texto', kw: 'citacao quote' },
  { k: 'callout', ic: 'idea', g: '💡', n: 'Destaque', d: 'Caixa de aviso', kw: 'destaque callout aviso' },
  { k: 'code', ic: 'code', g: '</>', n: 'Código', d: 'Bloco de código', kw: 'codigo code' },
  { k: 'hr', g: '—', n: 'Divisor', d: 'Linha horizontal', kw: 'divisor linha hr' },
];
const SHORTCUTS = { '# ': 'h1', '## ': 'h2', '### ': 'h3', '- ': 'ul', '* ': 'ul', '1. ': 'ol', '[] ': 'todo', '> ': 'quote' };
const LISTY = ['ul', 'ol', 'todo'];
const PH = { h1: 'Título 1', h2: 'Título 2', h3: 'Título 3', quote: 'Citação', callout: 'Escreva um destaque', todo: 'Tarefa', ul: 'Item da lista', ol: 'Item da lista' };
const idx = id => blocks.findIndex(b => b.id === id);

function renderEditor(focusId, pos) {
  const ed = $('#editor'); if (!ed) return;
  ed.textContent = '';
  let n = 0;
  blocks.forEach(b => { n = b.t === 'ol' ? n + 1 : 0; ed.append(blockEl(b, n)); });
  if (focusId) focusBlock(focusId, pos);
}
function blockEl(b, n) {
  const d = h('div', { class: 'block t-' + b.t + (b.t === 'todo' && b.c ? ' done' : ''), 'data-id': b.id, ...(b.t === 'ol' ? { 'data-n': n } : {}) });
  if (b.t === 'hr') { d.append(h('hr')); return d; }
  if (b.t === 'code') {
    const ta = h('textarea', { spellcheck: false, placeholder: 'Código…', rows: 1 });
    ta.value = b.x;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.oninput = () => { b.x = ta.value; grow(); touch(); };
    ta.onkeydown = e => {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      else if (e.key === 'Backspace' && !ta.value) { e.preventDefault(); b.t = 'p'; renderEditor(b.id, 0); touch(); }
      else if (e.key === 'ArrowUp' && ta.selectionStart === 0 && !e.shiftKey) { e.preventDefault(); focusRel(b.id, -1); }
      else if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length && !e.shiftKey) { e.preventDefault(); focusRel(b.id, 1); }
      else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveBlock(b.id, e.key === 'ArrowUp' ? -1 : 1); }
    };
    d.append(ta); requestAnimationFrame(grow);
    return d;
  }
  if (b.t === 'todo') {
    d.append(h('input', { type: 'checkbox', checked: !!b.c, 'aria-label': 'Concluída', onchange: e => {
      b.c = e.target.checked; d.classList.toggle('done', b.c); touch();
    } }));
  }
  const t = h('div', { class: 'txt', contenteditable: 'true', spellcheck: 'true', 'data-ph': PH[b.t] || "Digite '/' para comandos" });
  paintLinks(t, b.x);
  t.onclick = e => {
    const w = e.target.closest && e.target.closest('.wl');
    if (w && (e.ctrlKey || e.metaKey)) { e.preventDefault(); followLink(w.dataset.title); }
  };
  t.oninput = () => onInput(b, t);
  t.onkeydown = e => onKey(e, b, t);
  t.onpaste = e => onPaste(e, b, t);
  t.onblur = () => setTimeout(() => { if (slash.open && !document.activeElement?.closest('.txt')) closeSlash(); }, 120);
  d.append(t);
  return d;
}
function focusBlock(id, pos) {
  const d = document.querySelector(`.block[data-id="${id}"]`);
  const t = d && d.querySelector('.txt, textarea');
  if (!t) return;
  t.focus();
  if (t.tagName === 'TEXTAREA') { const p = pos == null || pos < 0 ? t.value.length : pos; t.setSelectionRange(p, p); return; }
  const len = t.textContent.length;
  let left = pos == null || pos < 0 ? len : Math.min(pos, len);
  const r = document.createRange(), s = getSelection();
  const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  let n, placed = false;
  while ((n = w.nextNode())) {
    if (left <= n.length) { r.setStart(n, left); placed = true; break; }
    left -= n.length;
  }
  if (!placed) r.setStart(t, t.childNodes.length);
  r.collapse(true); s.removeAllRanges(); s.addRange(r);
}
function caretPos(t) {
  const s = getSelection();
  if (!s.rangeCount) return 0;
  const r = s.getRangeAt(0), pre = r.cloneRange();
  pre.selectNodeContents(t); pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}
function atEdge(t, up) {
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed) return false;
  const len = t.textContent.length, pos = caretPos(t);
  if (!len) return true;
  const r = s.getRangeAt(0).cloneRange(); r.collapse(true);
  const rc = r.getClientRects()[0];
  if (!rc) return up ? pos === 0 : pos === len;
  const tr = t.getBoundingClientRect(), lh = parseFloat(getComputedStyle(t).lineHeight) || 24;
  return up ? rc.top - tr.top < lh * .9 : tr.bottom - rc.bottom < lh * .9;
}
function focusRel(id, dir) {
  let i = idx(id) + dir;
  while (blocks[i] && blocks[i].t === 'hr') i += dir;
  if (blocks[i]) return focusBlock(blocks[i].id, dir < 0 ? -1 : 0);
  if (dir > 0) { const b = newBlock(); blocks.push(b); renderEditor(b.id, 0); touch(); }
}
function moveBlock(id, dir) {
  const i = idx(id), j = i + dir;
  if (j < 0 || j >= blocks.length) return;
  [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  renderEditor(id, -1); touch();
}

function onInput(b, t) {
  b.x = getText(t);
  if (b.t === 'p' && SHORTCUTS[b.x]) {
    b.t = SHORTCUTS[b.x]; b.x = ''; if (b.t === 'todo') b.c = false;
    renderEditor(b.id, 0); touch(); return;
  }
  const lk = /\[\[([^\[\]\n]*)$/.exec(b.x.slice(0, caretPos(t)));
  if (b.x.startsWith('/') && !b.x.includes(' ')) openSlash(b, t);
  else if (lk) openLinkMenu(b, t, lk);
  else closeSlash();
  touch();
}
function onKey(e, b, t) {
  if (slash.open && slashKey(e)) return;
  const i = idx(b.id);
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const x = getText(t), pos = caretPos(t);
    if (LISTY.includes(b.t) && !x) { b.t = 'p'; renderEditor(b.id, 0); touch(); return; }
    const nb = newBlock(LISTY.includes(b.t) ? b.t : 'p', x.slice(pos));
    b.x = x.slice(0, pos);
    blocks.splice(i + 1, 0, nb);
    renderEditor(nb.id, 0); touch();
  } else if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault(); document.execCommand('insertText', false, '\n');
  } else if (e.key === 'Backspace' && getSelection().isCollapsed && caretPos(t) === 0) {
    e.preventDefault();
    if (b.t !== 'p') { b.t = 'p'; renderEditor(b.id, 0); touch(); return; }
    if (i === 0) return;
    const prev = blocks[i - 1];
    if (prev.t === 'hr') { blocks.splice(i - 1, 1); renderEditor(b.id, 0); touch(); return; }
    if (prev.t === 'code') { prev.x += (prev.x && b.x ? '\n' : '') + b.x; } else prev.x += b.x;
    const at = prev.x.length - b.x.length;
    blocks.splice(i, 1); renderEditor(prev.id, at); touch();
  } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); moveBlock(b.id, e.key === 'ArrowUp' ? -1 : 1);
  } else if (e.key === 'ArrowUp' && !e.shiftKey && atEdge(t, true)) {
    if (i > 0) { e.preventDefault(); focusRel(b.id, -1); } else { e.preventDefault(); $('.title')?.focus(); }
  } else if (e.key === 'ArrowDown' && !e.shiftKey && atEdge(t, false)) {
    if (i < blocks.length - 1) { e.preventDefault(); focusRel(b.id, 1); }
  }
}
function onPaste(e, b, t) {
  e.preventDefault();
  const text = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '');
  if (!text.includes('\n')) { document.execCommand('insertText', false, text); return; }
  const x = getText(t), pos = caretPos(t), lines = text.split('\n');
  const after = x.slice(pos);
  b.x = x.slice(0, pos) + lines[0];
  let last = b, at = b.x.length;
  const i = idx(b.id);
  lines.slice(1).forEach((ln, k) => {
    const nb = newBlock(LISTY.includes(b.t) ? b.t : 'p', ln);
    blocks.splice(i + 1 + k, 0, nb); last = nb; at = ln.length;
  });
  last.x += after;
  renderEditor(last.id, at); touch();
}

/* ---------- menu "/" ---------- */
const slash = { open: false, items: [], sel: 0, bid: null };
function openSlash(b, t) {
  const q = b.x.slice(1).toLowerCase();
  showMenu(b, t, TYPES.filter(x => !q || x.n.toLowerCase().includes(q) || x.kw.includes(q))
    .map(x => ({ ...x, run: bid => applyType(bid, x.k) })));
}
function openLinkMenu(b, t, m) {
  const pos = caretPos(t), start = pos - m[0].length, q = m[1].trim().toLowerCase();
  const items = pages.filter(p => !p.trashed && cur && p.id !== cur.id && (p.title || '').trim() && p.title.toLowerCase().includes(q))
    .slice(0, 8).map(p => ({ g: pageIcon(p.icon) || pic('file'), n: p.title, d: 'Linkar página', run: bid => insertLink(bid, start, pos, p.title) }));
  const exact = pages.some(p => !p.trashed && (p.title || '').trim().toLowerCase() === q);
  if (q && !exact) items.push({ g: pic('add'), n: `Criar “${m[1].trim()}”`, d: 'Nova página', run: async bid => {
    try {
      const r = await api('page_create', { body: { title: m[1].trim() } });
      pages.push(r.page); renderTree();
      insertLink(bid, start, pos, r.page.title);
    } catch (ex) { toast(ex.message); }
  } });
  showMenu(b, t, items);
}
function insertLink(bid, start, pos, title) {
  const b = blocks[idx(bid)]; if (!b) return;
  const name = title.replace(/[\[\]\n]/g, ' ').trim();
  b.x = b.x.slice(0, start) + `[[${name}]]` + b.x.slice(pos);
  renderEditor(bid, start + name.length + 4); touch();
}
function showMenu(b, t, items) {
  if (!items.length) return closeSlash();
  slash.items = items; slash.open = true; slash.bid = b.id; slash.sel = Math.min(slash.sel, items.length - 1);
  const m = $('#slash'), rc = t.getBoundingClientRect();
  m.hidden = false;
  m.style.left = Math.min(rc.left, innerWidth - 262) + 'px';
  const below = rc.bottom + 6, mh = Math.min(300, items.length * 52 + 8);
  m.style.top = (below + mh > innerHeight ? Math.max(8, rc.top - mh - 6) : below) + 'px';
  m.replaceChildren(...items.map((x, i) => {
    const btn = h('button', { class: i === slash.sel ? 'on' : '', type: 'button' }, h('span', { class: 'g' }, x.ic ? pic(x.ic) : x.g), h('span', {}, x.n, h('small', {}, x.d)));
    btn.onmousedown = ev => { ev.preventDefault(); pickSlash(i); };
    return btn;
  }));
  if (m.children[slash.sel]) m.children[slash.sel].scrollIntoView({ block: 'nearest' });
}
function closeSlash() { slash.open = false; slash.sel = 0; $('#slash').hidden = true; }
function slashKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    slash.sel = (slash.sel + (e.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length;
    [...$('#slash').children].forEach((c, i) => c.classList.toggle('on', i === slash.sel));
    $('#slash').children[slash.sel].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slash.sel); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return true; }
  return false;
}
function pickSlash(i) {
  const it = slash.items[i], bid = slash.bid;
  closeSlash();
  it.run(bid);
}
function applyType(bid, type) {
  const b = blocks[idx(bid)];
  if (!b) return;
  b.t = type; b.x = ''; if (type === 'todo') b.c = false; else delete b.c;
  if (type === 'hr') {
    const nb = newBlock(), at = idx(b.id) + 1;
    if (blocks[at] && blocks[at].t === 'p' && !blocks[at].x) { renderEditor(blocks[at].id, 0); touch(); return; }
    blocks.splice(at, 0, nb); renderEditor(nb.id, 0);
  } else renderEditor(b.id, 0);
  touch();
}

/* ---------- [[links]], backlinks e grafo ---------- */
const findByTitle = t => pages.find(p => !p.trashed && (p.title || '').trim().toLowerCase() === t.trim().toLowerCase());
function paintLinks(t, text) {
  t.textContent = '';
  const re = /\[\[([^\[\]\n]{1,200})\]\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) t.append(text.slice(last, m.index));
    t.append(h('span', { class: 'wl' + (findByTitle(m[1]) ? '' : ' ghost'), 'data-title': m[1], title: 'Ctrl+clique para abrir' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) t.append(text.slice(last));
}
async function followLink(title) {
  const p = findByTitle(title);
  if (p) return openPage(p.id);
  try {
    const r = await api('page_create', { body: { title: title.trim() } });
    pages.push(r.page); await openPage(r.page.id);
  } catch (ex) { toast(ex.message); }
}
function renderRefs() {
  const box = $('#refs'); if (!box || !cur) return;
  const chip = id => {
    const p = pages.find(x => x.id === id);
    return p ? h('button', { class: 'chip', onclick: () => openPage(id) }, pageIcon(p.icon) || pic('file'), ' ', p.title || 'Sem título') : null;
  };
  const outs = [...new Set(edges.filter(e => e.from === cur.id).map(e => e.to))];
  const ins = [...new Set(edges.filter(e => e.to === cur.id).map(e => e.from))];
  const kids = pages.filter(p => p.parent_id === cur.id && !p.trashed).map(p => p.id);
  const sec = (name, ids, icon) => ids.length ? h('div', { class: 'refsec' }, h('b', {}, pic(icon), name), ...ids.map(chip)) : null;
  box.replaceChildren(...[sec('Links nesta página', outs, 'link'), sec('Mencionada em', ins, 'bookmark'), sec('Subpáginas', kids, 'folder')].filter(Boolean));
}
$('#graphBtn').onclick = () => showGraph();
async function showGraph() {
  await flush(); await loadPages(); await loadLinks();
  cur = null; showingTrash = false; setSection('notes'); $('#crumbs').textContent = 'Grafo de ideias'; renderTree();
  $('#app').classList.remove('open');
  drawGraph({ pages, edges, onOpen: id => openPage(id) });
}
function drawGraph(o) {
  const view = $('#view');
  view.classList.add('flat');
  const canvas = h('canvas');
  const q = h('input', { class: 'gsearch', type: 'search', placeholder: 'Destacar página…' });
  const tc = h('input', { type: 'checkbox', checked: true });
  let W = 0, H = 0, dpr = 1;
  let tx = 0, ty = 0, k = 1, alpha = 1, hover = null, drag = null, pan = null, moved = 0, query = '';
  const world = (cx, cy) => ({ x: (cx - tx) / k, y: (cy - ty) / k });
  function zoomAt(cx, cy, f) {
    const nk = Math.min(4, Math.max(.15, k * f)), w = world(cx, cy);
    k = nk; tx = cx - w.x * k; ty = cy - w.y * k;
  }
  const zbtn = (l, f) => h('button', { class: 'btn', type: 'button', onclick: () => zoomAt(W / 2, H / 2, f) }, l);
  const wrap = h('div', { class: 'graph' }, canvas,
    h('div', { class: 'gtools' }, o.back ? h('button', { class: 'btn', type: 'button', onclick: o.back.fn }, '← ' + o.back.label) : null, q, h('label', { class: 'gchk' }, tc, 'Hierarquia'), zbtn('＋', 1.25), zbtn('－', .8)),
    h('div', { class: 'glegend' }, 'Linhas brilhantes: [[links]] · tracejadas: hierarquia · arraste os neurônios · clique para abrir'));
  view.replaceChildren(wrap);
  const ctx = canvas.getContext('2d');

  const live = o.pages.filter(p => !p.trashed);
  const N = live.map(p => ({ id: p.id, t: p.title || 'Sem título', x: (Math.random() - .5) * 400, y: (Math.random() - .5) * 400, vx: 0, vy: 0, deg: 0 }));
  const byId = new Map(N.map(n => [n.id, n]));
  const L = o.edges.map(e => ({ a: byId.get(e.from), b: byId.get(e.to) })).filter(l => l.a && l.b);
  const T = live.filter(p => p.parent_id != null && byId.has(p.parent_id)).map(p => ({ a: byId.get(p.id), b: byId.get(p.parent_id) }));
  [...L, ...T].forEach(l => { l.a.deg++; l.b.deg++; });
  N.forEach(n => { n.r = 5 + Math.sqrt(n.deg) * 2.6; });
  const adj = new Map(N.map(n => [n, new Set([n])]));
  [...L, ...T].forEach(l => { adj.get(l.a).add(l.b); adj.get(l.b).add(l.a); });

  function step() {
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      const a = N[i], b = N[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy + .5;
      if (d2 > 160000) continue;
      const d = Math.sqrt(d2), f = 2600 / d2 * alpha;
      dx = dx / d * f; dy = dy / d * f;
      a.vx -= dx; a.vy -= dy; b.vx += dx; b.vy += dy;
    }
    const spring = (l, rest, str) => {
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - rest) * str * alpha, fx = dx / d * f, fy = dy / d * f;
      l.a.vx += fx; l.a.vy += fy; l.b.vx -= fx; l.b.vy -= fy;
    };
    L.forEach(l => spring(l, 110, .06));
    if (tc.checked) T.forEach(l => spring(l, 80, .04));
    N.forEach(n => {
      n.vx -= n.x * .004 * alpha; n.vy -= n.y * .004 * alpha;
      if (n === drag) { n.vx = n.vy = 0; return; }
      n.vx *= .82; n.vy *= .82; n.x += n.vx; n.y += n.vy;
    });
    alpha = Math.max(alpha * .985, .015);
  }
  function fit() {
    if (!N.length) return;
    const xs = N.map(n => n.x), ys = N.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    k = Math.min(1.4, W / (maxX - minX + 160), H / (maxY - minY + 160));
    tx = W / 2 - (maxX + minX) / 2 * k; ty = H / 2 - (maxY + minY) / 2 * k;
  }
  function resize() {
    dpr = devicePixelRatio || 1; W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }
  const css = n => getComputedStyle(root).getPropertyValue(n).trim();
  const hit = (cx, cy) => {
    const w = world(cx, cy); let best = null, bd = 1e9;
    N.forEach(n => { const d = Math.hypot(n.x - w.x, n.y - w.y); if (d < n.r + 6 / k && d < bd) { best = n; bd = d; } });
    return best;
  };
  function draw(time) {
    const acc = css('--acc'), fg = css('--fg'), mut = css('--mut'), line = css('--line');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.translate(tx, ty); ctx.scale(k, k);
    const qq = query.trim().toLowerCase();
    const active = n => (!hover || adj.get(hover).has(n)) && (!qq || n.t.toLowerCase().includes(qq));
    if (tc.checked) {
      ctx.setLineDash([4 / k, 5 / k]); ctx.lineWidth = 1 / k; ctx.strokeStyle = mut;
      T.forEach(l => { ctx.globalAlpha = active(l.a) && active(l.b) ? .35 : .06; ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke(); });
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 1.5 / k; ctx.strokeStyle = acc; ctx.shadowColor = acc;
    L.forEach((l, i) => {
      const on = hover ? (l.a === hover || l.b === hover) : (!qq || (active(l.a) && active(l.b)));
      ctx.globalAlpha = on ? .75 : .08; ctx.shadowBlur = on ? 8 : 0;
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke();
      if (on) { // pulso sináptico
        const p = ((time / 2200) + i * .17) % 1;
        ctx.shadowBlur = 12; ctx.globalAlpha = 1; ctx.fillStyle = acc;
        ctx.beginPath(); ctx.arc(l.a.x + (l.b.x - l.a.x) * p, l.a.y + (l.b.y - l.a.y) * p, 2.2 / k, 0, 7); ctx.fill();
      }
    });
    N.forEach(n => {
      const on = active(n), linked = n.deg > 0;
      ctx.globalAlpha = on ? 1 : .15;
      ctx.shadowColor = acc; ctx.shadowBlur = on && linked ? 16 : 0;
      ctx.fillStyle = linked ? acc : mut;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill();
      ctx.shadowBlur = 0; ctx.lineWidth = 1.5 / k; ctx.strokeStyle = n === hover ? fg : line; ctx.stroke();
      if (on && (k > .7 || n === hover || (hover && adj.get(hover).has(n)) || qq)) {
        ctx.font = `${(n === hover ? 14 : 12) / k}px -apple-system,Segoe UI,sans-serif`;
        ctx.textAlign = 'center'; ctx.fillStyle = fg; ctx.globalAlpha = .95;
        ctx.fillText(n.t.length > 28 ? n.t.slice(0, 27) + '…' : n.t, n.x, n.y + n.r + 14 / k);
      }
    });
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  const ro = new ResizeObserver(resize); ro.observe(wrap);
  function frame(time) {
    if (!document.body.contains(canvas)) { ro.disconnect(); return; }
    if (alpha > .016 || drag) step();
    draw(time);
    requestAnimationFrame(frame);
  }
  resize();
  for (let i = 0; i < 220; i++) step();
  alpha = .3; fit();
  q.oninput = () => { query = q.value; };
  tc.onchange = () => { alpha = .8; };
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId); moved = 0;
    const r = canvas.getBoundingClientRect(), n = hit(e.clientX - r.left, e.clientY - r.top);
    if (n) { drag = n; alpha = .5; } else pan = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    if (drag) {
      const w = world(cx, cy);
      moved += Math.abs(drag.x - w.x) + Math.abs(drag.y - w.y);
      drag.x = w.x; drag.y = w.y; alpha = Math.max(alpha, .3);
    } else if (pan) {
      moved += Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y);
      tx += e.clientX - pan.x; ty += e.clientY - pan.y; pan = { x: e.clientX, y: e.clientY };
    } else { hover = hit(cx, cy); canvas.style.cursor = hover ? 'pointer' : 'grab'; }
  });
  const up = () => { if (drag && moved < 4) o.onOpen(drag.id); drag = null; pan = null; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : .89);
  }, { passive: false });
  if (!L.length) wrap.append(h('div', { class: 'gempty' }, 'Ainda não há conexões. Digite [[ em qualquer bloco para ligar uma ideia a outra página.'));
  requestAnimationFrame(frame);
}

/* ---------- lixeira ---------- */
$('#trashBtn').onclick = async () => {
  await flush();
  setSection('notes');
  await loadPages();
  showingTrash = true; cur = null; renderCrumbs(); renderTree();
  const list = h('div', { class: 'list' });
  const trashed = pages.filter(p => p.trashed);
  if (!trashed.length) list.append(h('div', { class: 'muted' }, 'A lixeira está vazia.'));
  trashed.forEach(p => list.append(h('div', { class: 'item' },
    h('span', {}, pageIcon(p.icon), ' ', p.title || 'Sem título',
      h('small', {}, (d => d > 0 ? `Exclusão automática em ${d} dia${d > 1 ? 's' : ''}` : 'Será excluída em breve')(Math.ceil(((p.trashed_at || serverNow) + 604800 - serverNow) / 86400)))),
    h('button', { class: 'btn', onclick: async () => { await api('page_restore', { body: { id: p.id } }); await loadPages(); $('#trashBtn').click(); } }, 'Restaurar'),
    h('button', { class: 'btn', onclick: async () => {
      if (!await ask('Excluir definitivamente?', [], 'Excluir', `"${p.title || 'Sem título'}" e suas subpáginas serão apagadas para sempre.`)) return;
      try { await api('page_delete', { body: { id: p.id } }); await loadPages(); $('#trashBtn').click(); } catch (ex) { toast(ex.message); }
    } }, 'Excluir'))));
  setView(h('div', { class: 'doc' }, h('h1', { class: 'ttl-ic' }, pic('trash', 'lg'), 'Lixeira'), h('p', { class: 'muted' }, 'As páginas na lixeira são excluídas automaticamente após 7 dias.'), list));
  $('#app').classList.remove('open');
};

/* ---------- diálogos ---------- */
const dlg = $('#dlg');
function ask(title, fields, ok = 'OK', text = '') {
  return new Promise(res => {
    const inputs = fields.map(f => h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', maxlength: f.maxlength, autocomplete: f.autocomplete || 'off', required: f.required }));
    const form = h('form', { method: 'dialog' }, h('h3', {}, title), text ? h('p', { class: 'muted' }, text) : null,
      ...fields.map((f, i) => h('label', {}, f.label, inputs[i])),
      h('div', { class: 'err', id: 'dErr' }),
      h('div', { class: 'row2' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancelar'), h('button', { class: 'btn primary', value: 'ok' }, ok)));
    dlg.replaceChildren(form);
    dlg.onclose = () => res(dlg.returnValue === 'ok' ? Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value])) : null);
    dlg.returnValue = '';
    dlg.showModal(); inputs[0]?.focus();
  });
}
$('#pwBtn').onclick = async () => {
  const v = await ask('Alterar senha', [], 'Enviar link', 'Por segurança, enviaremos um link de confirmação para o e-mail da sua conta. Nele você escolhe a nova senha.');
  if (!v) return;
  try {
    const r = await api('password_request', { body: {} });
    toast('Enviamos o link para ' + r.email);
  } catch (ex) { toast(ex.message); if (ex.status === 409) emailDialog(); }
};
async function showAdmin() {
  await flush(); cur = null; showingTrash = false; setSection('admin'); $('#app').classList.remove('open');
  let data;
  try { data = await api('admin_users'); } catch (ex) { return toast(ex.message); }
  const users = data.users;
  const fmt = t => t ? new Date(typeof t === 'number' ? t * 1000 : t.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const badge = (txt, k) => h('span', { class: 'badge ' + k }, txt);
  const stat = (n, label, icon) => h('div', { class: 'stat' }, pic(icon, 'lg'), h('div', {}, h('b', {}, String(n)), h('small', {}, label)));
  const run = async (u, op, msg, ask_) => {
    if (ask_ && !await ask('Confirmar ação', [], 'Confirmar', ask_)) return;
    try { await api('admin_action', { body: { id: u.id, op } }); toast(msg); showAdmin(); } catch (ex) { toast(ex.message); }
  };
  const list = h('div', { class: 'ulist' });
  const q = h('input', { class: 'asearch', type: 'search', placeholder: 'Buscar por nome ou e-mail…', 'aria-label': 'Buscar contas' });
  function card(u) {
    const self = u.id === data.me, who = u.email || u.username;
    const act = (ic, tip, fn, show = true) => show ? h('button', { class: 'act', title: tip, 'aria-label': tip, onclick: fn }, pic(ic)) : null;
    return h('div', { class: 'ucard' + (u.disabled ? ' off' : '') },
      h('div', { class: 'uinfo' }, h('b', {}, u.name), h('small', {}, who),
        h('div', { class: 'badges' }, ...[
          u.is_admin ? badge('Administrador', 'acc') : null,
          u.email ? (u.email_verified ? badge('E-mail confirmado', 'ok') : badge('E-mail pendente', 'warn')) : badge('Sem e-mail', 'mut'),
          u.disabled ? badge('Desativada', 'err') : null,
          self ? badge('Você', 'mut') : null].filter(Boolean))),
      h('div', { class: 'umeta' },
        h('span', {}, pic('document', 'sm'), ` ${u.pages} página${u.pages === 1 ? '' : 's'}`),
        h('span', {}, 'Criada em ' + fmt(u.created_at)),
        h('span', {}, 'Último acesso: ' + fmt(u.last_login))),
      h('div', { class: 'uacts' },
        act('lock', 'Enviar link para criar nova senha', () => run(u, 'reset_link', 'Link enviado para ' + who), !!u.email),
        act('bell', 'Reenviar confirmação de e-mail', () => run(u, 'resend', 'Confirmação reenviada'), !!u.email && !u.email_verified),
        act('done', 'Marcar e-mail como confirmado', () => run(u, 'verify', 'E-mail confirmado', `Marcar o e-mail de ${who} como confirmado sem que a pessoa clique no link?`), !!u.email && !u.email_verified),
        act('star', u.is_admin ? 'Remover de administrador' : 'Tornar administrador', () => run(u, 'toggle_admin', 'Papel atualizado', u.is_admin ? `Remover ${who} dos administradores?` : `Dar acesso de administrador a ${who}?`), !self),
        act(u.disabled ? 'sun' : 'moon', u.disabled ? 'Reativar conta' : 'Desativar conta', () => run(u, u.disabled ? 'enable' : 'disable', u.disabled ? 'Conta reativada' : 'Conta desativada', u.disabled ? null : `Desativar ${who}? A pessoa será desconectada e não poderá entrar.`), !self),
        act('trash', 'Excluir conta', () => run(u, 'delete', 'Conta excluída', `Excluir DEFINITIVAMENTE a conta de ${who} e todas as páginas dela? Isso não pode ser desfeito.`), !self)));
  }
  const renderList = () => {
    const f = q.value.trim().toLowerCase();
    const shown = users.filter(u => !f || (u.name + ' ' + (u.email || u.username)).toLowerCase().includes(f));
    list.replaceChildren(...(shown.length ? shown.map(card) : [h('p', { class: 'muted' }, 'Nenhuma conta encontrada.')]));
  };
  q.oninput = renderList; renderList();
  const invite = async () => {
    const v = await ask('Convidar usuário', [
      { name: 'name', label: 'Nome', maxlength: 80 },
      { name: 'email', label: 'E-mail', type: 'email', autocomplete: 'off', required: true },
    ], 'Enviar convite', 'A pessoa recebe um e-mail para definir a própria senha.');
    if (!v) return;
    try { await api('admin_invite', { body: v }); toast('Convite enviado para ' + v.email); showAdmin(); } catch (ex) { toast(ex.message); }
  };
  const total = users.reduce((n, u) => n + u.pages, 0);
  const log = data.log.length
    ? h('div', { class: 'alog' }, ...data.log.map(l => h('div', {}, h('small', {}, fmt(l.ts)), h('span', {}, `${l.admin || 'Administrador'} ${l.action} `, h('b', {}, l.target)))))
    : h('p', { class: 'muted' }, 'Nenhuma ação registrada ainda.');
  setView(h('div', { class: 'doc admin' },
    h('h1', { class: 'ttl-ic' }, pic('settings', 'lg'), 'Administração'),
    h('p', { class: 'muted' }, 'Gerencie as contas do Workflow SLOM. Por privacidade, administradores veem apenas dados da conta, nunca o conteúdo das páginas de outras pessoas.'),
    h('div', { class: 'stats' },
      stat(users.length, 'Contas', 'team'),
      stat(users.filter(u => u.is_admin).length, 'Administradores', 'star'),
      stat(users.filter(u => u.email && !u.email_verified).length, 'E-mail pendente', 'bell'),
      stat(users.filter(u => u.disabled).length, 'Desativadas', 'moon'),
      stat(total, 'Páginas (total)', 'document')),
    h('div', { class: 'atools' }, q, h('button', { class: 'btn primary', onclick: invite }, pic('add', 'sm'), ' Convidar usuário')),
    list,
    h('h2', { class: 'ttl-ic' }, pic('checklist'), 'Registro de ações'), log));
}

let toastT;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', style: 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:9px 16px;border-radius:8px;font-size:14px;z-index:99' }); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500);
}

/* ---------- abas (secoes) ---------- */
const SECTIONS = [
  { id: 'home', n: 'Início', ic: 'home' },
  { id: 'tasks', n: 'Tarefas', ic: 'kanban' },
  { id: 'notes', n: 'Anotações', ic: 'notebook' },
  { id: 'team', n: 'Equipe', ic: 'team' },
  { id: 'admin', n: 'Administração', ic: 'settings', admin: true },
];
const modules = {};
function renderTabs() {
  const t = $('#tabs'); t.textContent = '';
  if (!ME) return;
  SECTIONS.filter(s => ME.is_admin ? s.admin : !s.admin).forEach(s =>
    t.append(h('button', { class: 'tab' + (s.id === section ? ' on' : ''), onclick: () => go(s.id) }, pic(s.ic), h('span', {}, s.n))));
}
function renderCtx() {
  ['Home', 'Tasks', 'Notes', 'Team'].forEach(n => { $('#ctx' + n).hidden = section !== n.toLowerCase(); });
  $('#subbar').hidden = section !== 'notes';
  const m = modules[section]; if (m && m.ctx) m.ctx();
}
function setSection(id) { if (section !== id) { section = id; renderTabs(); renderCtx(); } }
async function go(id, arg) {
  if (section === 'notes') await flush();
  section = id; store.set('section', id);
  if (id !== 'notes') { cur = null; showingTrash = false; }
  renderTabs(); renderCtx();
  $('#app').classList.remove('open');
  if (id !== 'notes') history.replaceState(null, '', '#' + id);
  if (id === 'notes') {
    const live = pages.filter(p => !p.trashed);
    const p = live.find(x => x.id === +store.get('last')) || live[0];
    return p ? openPage(p.id) : renderHome();
  }
  if (id === 'admin') return showAdmin();
  const m = modules[id];
  if (m) await m.render(arg);
}
window.SLOM = {
  api, h, pic, ask, toast, store, setView, go, flush, drawGraph, dlg, ICON_NAMES,
  me: () => ME, section: () => section,
  register: (id, m) => { modules[id] = m; },
};
(window.__mods || []).forEach(f => f(window.SLOM));

/* ---------- início ---------- */
(async () => {
  try {
    const qs = new URLSearchParams(location.search);
    const vt = qs.get('verify'), rt = qs.get('reset');
    if (vt || rt) history.replaceState(null, '', location.pathname + location.hash);
    let r = await api('me');
    CSRF = r.csrf; SIGNUP = r.signup;
    let vOk = false, vErr = '';
    if (vt) {
      try { await api('verify', { body: { token: vt } }); vOk = true; r = await api('me'); CSRF = r.csrf; }
      catch (ex) { vErr = ex.message; }
    }
    ME = rt ? null : r.user;
    if (ME) { await startApp(); if (vOk) toast('E-mail confirmado!'); else if (vErr) toast(vErr); return; }
    showAuth(r.setup);
    if (rt) { resetToken = rt; setMode('reset'); }
    else if (vOk) setMode('login', 'E-mail confirmado! Entre para continuar.');
    else if (vErr) setMode('login', null, vErr);
  } catch (ex) {
    document.body.textContent = 'Não foi possível conectar ao servidor: ' + ex.message;
  }
})();
})();
