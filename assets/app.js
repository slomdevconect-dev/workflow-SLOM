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
let dirty = false, saveT = null, showingTrash = false;
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
    throw Object.assign(new Error(j.error || 'Erro'), { status: r.status });
  }
  return j;
}

/* ---------- tema ---------- */
const root = document.documentElement;
if (store.get('theme')) root.dataset.theme = store.get('theme');
else root.dataset.theme = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
$('#themeBtn').onclick = () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  store.set('theme', root.dataset.theme);
};

/* ---------- autenticação ---------- */
let setupMode = false;
function showAuth(setup) {
  setupMode = setup;
  $('#app').hidden = true; $('#auth').hidden = false;
  $('#nameRow').hidden = $('#pass2Row').hidden = !setup;
  $('#authMsg').textContent = setup ? 'Primeiro acesso: crie a conta de administrador.' : 'Entre para acessar suas páginas.';
  $('#authBtn').textContent = setup ? 'Criar conta' : 'Entrar';
  $('#aPass').autocomplete = setup ? 'new-password' : 'current-password';
  $('#aPass').value = $('#aPass2').value = '';
  $('#authErr').textContent = '';
  $('#aUser').focus();
}
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#authErr'), btn = $('#authBtn');
  err.textContent = '';
  if (setupMode && $('#aPass').value !== $('#aPass2').value) { err.textContent = 'As senhas não conferem'; return; }
  btn.disabled = true;
  try {
    const body = { username: $('#aUser').value, password: $('#aPass').value };
    if (setupMode) body.name = $('#aName').value;
    const r = await api(setupMode ? 'setup' : 'login', { body });
    CSRF = r.csrf; ME = r.user;
    await startApp();
  } catch (ex) { err.textContent = ex.message; }
  btn.disabled = false;
});
$('#logoutBtn').onclick = async () => {
  await flush();
  try { await api('logout', { body: {} }); } catch {}
  ME = null; cur = null; pages = []; location.hash = '';
  const r = await api('me'); CSRF = r.csrf;
  showAuth(r.setup);
};

/* ---------- app ---------- */
async function startApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#meName').textContent = ME.name;
  $('#usersBtn').hidden = !ME.is_admin;
  await loadPages();
  if (!pages.some(p => !p.trashed)) {
    const r = await api('page_create', { body: { title: 'Primeiros passos', icon: '👋', content: WELCOME() } });
    pages.push(r.page);
  }
  const want = +location.hash.slice(2) || +store.get('last');
  const live = pages.filter(p => !p.trashed);
  await openPage((live.find(p => p.id === want) || live[0]).id, false);
}
async function loadPages() {
  pages = (await api('pages')).pages;
  renderTree();
}
const WELCOME = () => [
  { id: uid(), t: 'p', x: 'Este é o seu espaço. Cada página é feita de blocos.' },
  { id: uid(), t: 'h2', x: 'Como usar' },
  { id: uid(), t: 'ul', x: 'Digite / em uma linha vazia para escolher o tipo de bloco.' },
  { id: uid(), t: 'ul', x: 'Atalhos: "# " título, "- " lista, "1. " numerada, "[] " tarefa, "> " citação.' },
  { id: uid(), t: 'ul', x: 'Alt + ↑ / ↓ move o bloco. Ctrl + S salva agora.' },
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
    h('button', { class: 'tw', title: 'Expandir', onclick: ev => { ev.stopPropagation(); toggle(p.id); } }, hasKids ? (expanded.has(p.id) ? '▾' : '▸') : ''),
    h('span', { class: 'ic' }, p.icon || '📄'),
    h('span', { class: 'tt' }, p.title || 'Sem título'),
    h('span', { class: 'acts' },
      h('button', { title: 'Nova subpágina', onclick: ev => { ev.stopPropagation(); createPage(p.id); } }, '＋'),
      h('button', { title: 'Mover para a lixeira', onclick: ev => { ev.stopPropagation(); trashPage(p.id); } }, '🗑')));
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
$('#search').oninput = renderTree;
$('#menuBtn').onclick = () => $('#app').classList.toggle('open');
$('#scrim').onclick = () => $('#app').classList.remove('open');

/* ---------- página ---------- */
async function openPage(id, pushHash = true) {
  await flush();
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
    c.append(i < chain.length - 1 ? h('a', { onclick: () => openPage(p.id) }, (p.icon || '') + ' ' + (p.title || 'Sem título')) : (p.icon || '') + ' ' + (p.title || 'Sem título'));
  });
}
function renderHome() {
  showingTrash = false; renderCrumbs(); renderTree();
  $('#view').replaceChildren(h('div', { class: 'empty-view' }, h('h2', {}, 'Nenhuma página aberta'),
    h('button', { class: 'btn primary', onclick: () => createPage(null) }, 'Criar página')));
}
function renderPage() {
  const icon = h('div', { class: 'page-ic' + (cur.icon ? '' : ' empty'), title: 'Alterar ícone', onclick: async () => {
    const v = await ask('Ícone da página', [{ name: 'icon', label: 'Emoji (vazio remove)', value: cur.icon, maxlength: 8 }], 'Salvar');
    if (!v) return;
    cur.icon = v.icon.trim(); touch(); syncMeta(); renderPage();
  } }, cur.icon || '＋ Ícone');
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
  $('#view').replaceChildren(h('div', { class: 'doc' }, icon, title, h('div', { id: 'editor' }), hint));
  renderEditor();
  setStatus('');
}
function syncMeta() {
  const p = pages.find(x => x.id === cur.id);
  if (p) { p.title = cur.title; p.icon = cur.icon; }
  renderTree(); renderCrumbs();
}

/* ---------- salvamento ---------- */
function setStatus(s) { $('#status').textContent = s; }
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
    setStatus('Salvo');
  } catch (ex) { dirty = true; setStatus('Erro ao salvar'); toast(ex.message); }
}
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(true); });
addEventListener('pagehide', () => flush(true));

/* ---------- editor de blocos ---------- */
const newBlock = (t = 'p', x = '') => ({ id: uid(), t, x, ...(t === 'todo' ? { c: false } : {}) });
const TYPES = [
  { k: 'p', g: '¶', n: 'Texto', d: 'Parágrafo simples', kw: 'texto paragrafo text' },
  { k: 'h1', g: 'H1', n: 'Título 1', d: 'Título grande', kw: 'titulo heading h1' },
  { k: 'h2', g: 'H2', n: 'Título 2', d: 'Título médio', kw: 'titulo heading h2' },
  { k: 'h3', g: 'H3', n: 'Título 3', d: 'Título pequeno', kw: 'titulo heading h3' },
  { k: 'todo', g: '☑', n: 'Tarefa', d: 'Lista de tarefas', kw: 'todo tarefa checkbox' },
  { k: 'ul', g: '•', n: 'Lista', d: 'Lista com marcadores', kw: 'lista bullet' },
  { k: 'ol', g: '1.', n: 'Lista numerada', d: 'Lista em ordem', kw: 'lista numerada number' },
  { k: 'quote', g: '❝', n: 'Citação', d: 'Destaque de texto', kw: 'citacao quote' },
  { k: 'callout', g: '💡', n: 'Destaque', d: 'Caixa de aviso', kw: 'destaque callout aviso' },
  { k: 'code', g: '</>', n: 'Código', d: 'Bloco de código', kw: 'codigo code' },
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
  t.textContent = b.x;
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
  const len = t.textContent.length, p = pos == null || pos < 0 ? len : Math.min(pos, len);
  const r = document.createRange(), s = getSelection();
  if (t.firstChild) r.setStart(t.firstChild, p); else r.setStart(t, 0);
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
  if (b.x.startsWith('/') && !b.x.includes(' ')) openSlash(b, t); else closeSlash();
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
  slash.items = TYPES.filter(x => !q || x.n.toLowerCase().includes(q) || x.kw.includes(q));
  if (!slash.items.length) return closeSlash();
  slash.open = true; slash.bid = b.id; slash.sel = Math.min(slash.sel, slash.items.length - 1);
  const m = $('#slash'), rc = t.getBoundingClientRect();
  m.hidden = false;
  m.style.left = Math.min(rc.left, innerWidth - 262) + 'px';
  const below = rc.bottom + 6, mh = Math.min(300, slash.items.length * 52 + 8);
  m.style.top = (below + mh > innerHeight ? Math.max(8, rc.top - mh - 6) : below) + 'px';
  m.replaceChildren(...slash.items.map((x, i) => {
    const btn = h('button', { class: i === slash.sel ? 'on' : '', type: 'button' }, h('span', { class: 'g' }, x.g), h('span', {}, x.n, h('small', {}, x.d)));
    btn.onmousedown = ev => { ev.preventDefault(); pickSlash(i); };
    return btn;
  }));
  m.children[slash.sel]?.scrollIntoView({ block: 'nearest' });
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
  const type = slash.items[i].k, b = blocks[idx(slash.bid)];
  closeSlash();
  if (!b) return;
  b.t = type; b.x = ''; if (type === 'todo') b.c = false; else delete b.c;
  if (type === 'hr') {
    const nb = newBlock(), at = idx(b.id) + 1;
    if (blocks[at]?.t === 'p' && !blocks[at].x) { renderEditor(blocks[at].id, 0); touch(); return; }
    blocks.splice(at, 0, nb); renderEditor(nb.id, 0);
  } else renderEditor(b.id, 0);
  touch();
}

/* ---------- lixeira ---------- */
$('#trashBtn').onclick = async () => {
  await flush();
  await loadPages();
  showingTrash = true; cur = null; renderCrumbs(); renderTree();
  const list = h('div', { class: 'list' });
  const trashed = pages.filter(p => p.trashed);
  if (!trashed.length) list.append(h('div', { class: 'muted' }, 'A lixeira está vazia.'));
  trashed.forEach(p => list.append(h('div', { class: 'item' },
    h('span', {}, (p.icon || '📄') + ' ' + (p.title || 'Sem título')),
    h('button', { class: 'btn', onclick: async () => { await api('page_restore', { body: { id: p.id } }); await loadPages(); $('#trashBtn').click(); } }, 'Restaurar'),
    h('button', { class: 'btn', onclick: async () => {
      if (!await ask('Excluir definitivamente?', [], 'Excluir', `"${p.title || 'Sem título'}" e suas subpáginas serão apagadas para sempre.`)) return;
      try { await api('page_delete', { body: { id: p.id } }); await loadPages(); $('#trashBtn').click(); } catch (ex) { toast(ex.message); }
    } }, 'Excluir'))));
  $('#view').replaceChildren(h('div', { class: 'doc' }, h('h1', { style: 'margin-top:30px' }, '🗑 Lixeira'), list));
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
  const v = await ask('Alterar senha', [
    { name: 'current', label: 'Senha atual', type: 'password', autocomplete: 'current-password', required: true },
    { name: 'password', label: 'Nova senha (mín. 8)', type: 'password', autocomplete: 'new-password', required: true },
  ], 'Alterar');
  if (!v) return;
  try { await api('password', { body: v }); toast('Senha alterada'); } catch (ex) { toast(ex.message); }
};
$('#usersBtn').onclick = async () => {
  const { users } = await api('users');
  const err = h('div', { class: 'err' });
  const f = { username: h('input', { placeholder: 'usuário', autocomplete: 'off', required: true }), name: h('input', { placeholder: 'nome', autocomplete: 'off' }), password: h('input', { placeholder: 'senha (mín. 8)', type: 'password', autocomplete: 'new-password', required: true }) };
  const form = h('form', { method: 'dialog' }, h('h3', {}, 'Usuários'),
    h('div', { class: 'list' }, ...users.map(u => h('div', { class: 'item' }, h('span', {}, `${u.name} (${u.username})`), u.is_admin ? h('small', { class: 'muted' }, 'admin') : null))),
    h('h3', { style: 'margin-top:12px' }, 'Adicionar'), f.username, f.name, f.password, err,
    h('div', { class: 'row2' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Fechar'), h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try { await api('user_add', { body: { username: f.username.value, name: f.name.value, password: f.password.value } }); dlg.close(); toast('Usuário criado'); } catch (ex) { err.textContent = ex.message; }
    } }, 'Criar')));
  dlg.replaceChildren(form); dlg.onclose = null; dlg.showModal();
};

let toastT;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', style: 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:9px 16px;border-radius:8px;font-size:14px;z-index:99' }); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500);
}

/* ---------- início ---------- */
(async () => {
  try {
    const r = await api('me');
    CSRF = r.csrf; ME = r.user;
    if (ME) await startApp(); else showAuth(r.setup);
  } catch (ex) {
    document.body.textContent = 'Não foi possível conectar ao servidor: ' + ex.message;
  }
})();
})();
