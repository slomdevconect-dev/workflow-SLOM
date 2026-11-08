/* Planejamento de tarefas: painel inicial, quadro, lista e calendario. */
(window.__mods = window.__mods || []).push(function (S) {
  'use strict';
  const { api, h, pic, ask, toast, store } = S;
  const $ = s => document.querySelector(s);

  const STATUS = [
    { id: 'backlog', n: 'Backlog', ic: 'stack', c: '#8a94a6' },
    { id: 'todo', n: 'A fazer', ic: 'checklist', c: '#4da3ff' },
    { id: 'doing', n: 'Em andamento', ic: 'timer-play', c: '#f5a524' },
    { id: 'review', n: 'Em revisão', ic: 'search', c: '#b388ff' },
    { id: 'done', n: 'Concluído', ic: 'done', c: '#2fb36d' },
  ];
  const PRIO = [
    { id: 'low', n: 'Baixa', c: '#8a94a6' },
    { id: 'medium', n: 'Média', c: '#4da3ff' },
    { id: 'high', n: 'Alta', c: '#f5a524' },
    { id: 'urgent', n: 'Urgente', c: '#f0506e' },
  ];
  const SMAP = Object.fromEntries(STATUS.map(s => [s.id, s]));
  const PMAP = Object.fromEntries(PRIO.map(p => [p.id, p]));
  const COLORS = ['#4da3ff', '#b388ff', '#4cd08a', '#ff8a4c', '#e0457b', '#f5c542'];

  let D = { tasks: [], projects: [], members: [], now: 0 }, loaded = false;
  const F = { project: '', who: '', prio: '', q: '', view: store.get('tview') || 'board' };
  let calMonth = new Date(); calMonth.setDate(1);

  /* ---------- utilidades ---------- */
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dayDiff = s => Math.round((parse(s) - parse(todayStr())) / 86400000);
  const short = s => { const [, m, d] = s.split('-'); return `${d}/${m}`; };
  const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const me = () => S.me();
  const member = id => D.members.find(m => m.id === id);
  const project = id => D.projects.find(p => p.id === id);
  const initials = n => (n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (m, cls = '') => h('span', { class: ('av ' + cls).trim(), style: `background:${COLORS[(m ? m.id : 0) % COLORS.length]}`, title: m ? m.name : 'Sem responsável' }, m ? initials(m.name) : '?');
  const ago = ts => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (d < 60) return 'agora';
    if (d < 3600) return `há ${Math.floor(d / 60)} min`;
    if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
    return `há ${Math.floor(d / 86400)} d`;
  };
  S.util = { avatar, initials, COLORS, ago, STATUS, PRIO, SMAP, PMAP };

  async function load() {
    D = await api('tasks_all'); loaded = true;
    renderProjects();
  }
  const refresh = async () => { await load(); if (S.section() === 'tasks') draw(); else if (S.section() === 'home') renderHome(); };

  function dueBadge(t) {
    if (!t.due_date) return null;
    const d = dayDiff(t.due_date);
    let txt = short(t.due_date), cls = '';
    if (t.status !== 'done') {
      if (d < 0) { txt = `Atrasada ${-d}d`; cls = 'late'; }
      else if (d === 0) { txt = 'Hoje'; cls = 'today'; }
      else if (d === 1) { txt = 'Amanhã'; cls = 'soon'; }
      else if (d <= 6) { txt = `${WD[parse(t.due_date).getDay()]}, ${short(t.due_date)}`; cls = 'soon'; }
    }
    return h('span', { class: 'due ' + cls }, pic('calendar', 'sm'), txt);
  }
  const projChip = pj => pj ? h('span', { class: 'tproj', style: `--c:${pj.color}` }, pj.name) : null;
  const prioChip = p => h('span', { class: 'pchip', style: `--c:${PMAP[p].c}` }, PMAP[p].n);

  function visible() {
    const q = F.q.trim().toLowerCase();
    return D.tasks.filter(t =>
      (!F.project || String(t.project_id) === F.project) &&
      (!F.who || (F.who === 'me' ? t.assignee_id === me().id : F.who === 'none' ? !t.assignee_id : String(t.assignee_id) === F.who)) &&
      (!F.prio || t.priority === F.prio) &&
      (!q || (t.title + ' ' + t.description + ' ' + t.labels.join(' ')).toLowerCase().includes(q)));
  }
  const bodyOf = t => ({ id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, assignee_id: t.assignee_id, project_id: t.project_id, due_date: t.due_date, labels: t.labels, checklist: t.checklist });

  async function moveTask(id, status, idx) {
    const t = D.tasks.find(x => x.id === id); if (!t) return;
    const others = D.tasks.filter(x => x.status === status && x.id !== id).sort((a, b) => a.position - b.position || a.id - b.id);
    others.splice(Math.min(idx, others.length), 0, t);
    others.forEach((x, i) => { x.position = i; });
    t.status = status; t.completed_at = status === 'done' ? (t.completed_at || D.now) : null;
    draw();
    try { await api('task_move', { body: { id, status, index: Math.max(0, others.indexOf(t)) } }); await load(); draw(); }
    catch (ex) { toast(ex.message); await load(); draw(); }
  }
  async function toggleDone(t) {
    await moveTask(t.id, t.status === 'done' ? 'todo' : 'done', 9999);
    if (S.section() === 'home') renderHome();
  }

  /* ---------- tarefa (janela) ---------- */
  async function openTask(id, preset = {}) {
    if (!loaded) await load();
    const t = id ? D.tasks.find(x => x.id === id) : null;
    const s = t ? JSON.parse(JSON.stringify(t)) : {
      title: '', description: '', status: preset.status || 'todo', priority: 'medium',
      assignee_id: preset.assignee_id === undefined ? me().id : preset.assignee_id,
      project_id: F.project ? +F.project : (D.projects[0] ? D.projects[0].id : null),
      due_date: preset.due_date || '', labels: [], checklist: [],
    };
    const dlg = h('dialog', { class: 'dlg task-dlg' });
    const sel = (opts, val) => { const e = h('select', {}, ...opts.map(([v, l]) => h('option', { value: v == null ? '' : v }, l))); e.value = val == null ? '' : String(val); return e; };
    const title = h('input', { class: 'tt-input', placeholder: 'Título da tarefa', value: s.title, maxlength: 200 });
    const status = sel(STATUS.map(x => [x.id, x.n]), s.status);
    const prio = sel(PRIO.map(x => [x.id, x.n]), s.priority);
    const who = sel([['', 'Sem responsável'], ...D.members.map(m => [m.id, m.name])], s.assignee_id);
    const proj = sel([['', 'Sem projeto'], ...D.projects.map(p => [p.id, p.name])], s.project_id);
    const due = h('input', { type: 'date', value: s.due_date || '' });
    const labels = h('input', { placeholder: 'etiquetas separadas por vírgula', value: s.labels.join(', ') });
    const desc = h('textarea', { rows: 4, placeholder: 'Descreva a tarefa, critérios de aceite, links…', maxlength: 5000 }); desc.value = s.description;
    const fld = (l, e) => h('label', {}, l, e);

    const clBox = h('div', { class: 'checklist' });
    const clAdd = h('input', { placeholder: 'Adicionar item à checklist e tecle Enter' });
    const drawCL = () => {
      const d = s.checklist.filter(c => c.d).length;
      const rows = s.checklist.map((c, i) => h('div', { class: 'cli' + (c.d ? ' d' : '') },
        h('input', { type: 'checkbox', checked: c.d, onchange: e => { c.d = e.target.checked; drawCL(); } }),
        h('span', {}, c.t), h('button', { type: 'button', class: 'x', title: 'Remover', onclick: () => { s.checklist.splice(i, 1); drawCL(); } }, '×')));
      if (s.checklist.length) rows.push(h('div', { class: 'clbar' }, h('i', { style: `width:${Math.round(100 * d / s.checklist.length)}%` })));
      clBox.replaceChildren(...rows);
    };
    clAdd.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const v = clAdd.value.trim(); if (v) { s.checklist.push({ t: v, d: false }); clAdd.value = ''; drawCL(); } } };
    drawCL();

    const err = h('div', { class: 'err' });
    const comments = h('div', { class: 'comments' });
    const cin = h('input', { placeholder: 'Escreva um comentário…' });
    async function drawComments() {
      if (!t) return;
      const { comments: list } = await api('task_comments', { q: '&id=' + t.id });
      comments.replaceChildren(...list.map(c => h('div', { class: 'cm' }, avatar(member(c.user_id) || { id: c.user_id || 0, name: c.name || '?' }, 'sm'),
        h('div', {}, h('b', {}, c.name || 'Usuário'), h('small', {}, ' ' + ago(c.created_at)), h('p', {}, c.body)))));
    }
    const send = async () => {
      const v = cin.value.trim(); if (!v) return;
      try { await api('task_comment_add', { body: { id: t.id, body: v } }); cin.value = ''; await drawComments(); await load(); } catch (ex) { err.textContent = ex.message; }
    };
    cin.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); send(); } };

    const save = async () => {
      err.textContent = '';
      if (!title.value.trim()) { err.textContent = 'Informe o título da tarefa'; title.focus(); return; }
      const body = {
        id: t ? t.id : undefined, title: title.value, description: desc.value, status: status.value, priority: prio.value,
        assignee_id: who.value || null, project_id: proj.value || null, due_date: due.value || null,
        labels: labels.value.split(',').map(x => x.trim()).filter(Boolean), checklist: s.checklist,
      };
      try { await api('task_save', { body }); dlg.close(); toast(t ? 'Tarefa atualizada' : 'Tarefa criada'); await refresh(); } catch (ex) { err.textContent = ex.message; }
    };
    const del = async () => {
      if (!await ask('Excluir tarefa?', [], 'Excluir', `“${t.title}” e os comentários dela serão apagados.`)) return;
      try { await api('task_delete', { body: { id: t.id } }); dlg.close(); toast('Tarefa excluída'); await refresh(); } catch (ex) { err.textContent = ex.message; }
    };
    const creator = t && member(t.creator_id);
    dlg.append(h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); save(); } },
      h('div', { class: 'tdh' }, pic(SMAP[s.status].ic, 'lg'), title),
      h('div', { class: 'tgrid' }, fld('Status', status), fld('Prioridade', prio), fld('Responsável', who), fld('Projeto', proj), fld('Prazo', due), fld('Etiquetas', labels)),
      fld('Descrição', desc),
      h('div', { class: 'sect' }, h('b', {}, pic('checklist', 'sm'), ' Checklist'), clBox, clAdd),
      t ? h('div', { class: 'sect' }, h('b', {}, pic('note', 'sm'), ' Comentários'), comments, h('div', { class: 'cmadd' }, cin, h('button', { type: 'button', class: 'btn', onclick: send }, 'Enviar'))) : null,
      t ? h('small', { class: 'muted' }, `Criada por ${creator ? creator.name : '—'} em ${new Date(t.created_at * 1000).toLocaleDateString('pt-BR')}`) : null,
      err,
      h('div', { class: 'row2' },
        t ? h('button', { type: 'button', class: 'btn danger', onclick: del }, 'Excluir') : null, h('span', { class: 'sp' }),
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancelar'),
        h('button', { class: 'btn primary' }, t ? 'Salvar' : 'Criar tarefa'))));
    dlg.onclose = () => dlg.remove();
    document.body.append(dlg); dlg.showModal();
    if (!t) title.focus();
    drawComments();
  }

  /* ---------- quadro ---------- */
  let marker = null;
  const clearMarker = () => { if (marker) marker.remove(); };
  function placeMarker(body, y) {
    if (!marker) marker = h('div', { class: 'dropline' });
    const after = [...body.querySelectorAll('.tcard:not(.dragging)')].find(c => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (after) body.insertBefore(marker, after); else body.append(marker);
  }
  function card(t) {
    const pj = project(t.project_id), as = member(t.assignee_id), done = t.checklist.filter(c => c.d).length;
    const el = h('div', { class: 'tcard' + (t.status === 'done' ? ' isdone' : ''), draggable: 'true', 'data-id': t.id, style: `--pc:${PMAP[t.priority].c}` },
      h('div', { class: 'tchips' }, projChip(pj), t.priority === 'urgent' || t.priority === 'high' ? prioChip(t.priority) : null),
      h('div', { class: 'ttitle' }, t.title),
      t.labels.length ? h('div', { class: 'tlabels' }, ...t.labels.map(l => h('span', { class: 'tlabel' }, l))) : null,
      h('div', { class: 'tfoot' }, dueBadge(t),
        t.checklist.length ? h('span', { class: 'tmeta' }, pic('checklist', 'sm'), `${done}/${t.checklist.length}`) : null,
        t.comments ? h('span', { class: 'tmeta' }, pic('note', 'sm'), String(t.comments)) : null,
        h('span', { class: 'sp' }), as ? avatar(as, 'sm') : null));
    el.onclick = () => openTask(t.id);
    el.ondragstart = e => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => el.classList.add('dragging'), 0); };
    el.ondragend = () => { el.classList.remove('dragging'); clearMarker(); document.querySelectorAll('.col.over').forEach(c => c.classList.remove('over')); };
    return el;
  }
  function renderBoard(host) {
    const vis = visible(), board = h('div', { class: 'board' });
    STATUS.forEach(st => {
      const items = vis.filter(t => t.status === st.id).sort((a, b) => a.position - b.position || a.id - b.id);
      const body = h('div', { class: 'colbody' }, ...items.map(card));
      if (!items.length) body.append(h('div', { class: 'colempty' }, 'Solte tarefas aqui'));
      const col = h('section', { class: 'col', style: `--c:${st.c}` },
        h('header', { class: 'colhead' }, pic(st.ic, 'sm'), h('b', {}, st.n), h('span', { class: 'cnt' }, String(items.length)),
          h('button', { class: 'colplus', title: 'Adicionar tarefa', onclick: () => openTask(null, { status: st.id }) }, pic('add', 'sm'))),
        body, h('button', { class: 'coladd', onclick: () => openTask(null, { status: st.id }) }, pic('add', 'sm'), ' Adicionar tarefa'));
      body.ondragover = e => { e.preventDefault(); col.classList.add('over'); const em = body.querySelector('.colempty'); if (em) em.remove(); placeMarker(body, e.clientY); };
      body.ondragleave = e => { if (!body.contains(e.relatedTarget)) { col.classList.remove('over'); clearMarker(); } };
      body.ondrop = e => {
        e.preventDefault(); col.classList.remove('over');
        const id = +e.dataTransfer.getData('text/plain');
        const nx = marker && marker.parentNode === body ? marker.nextElementSibling : null;
        const nextId = nx && nx.classList.contains('tcard') ? +nx.dataset.id : null;
        clearMarker();
        const full = D.tasks.filter(t => t.status === st.id && t.id !== id).sort((a, b) => a.position - b.position || a.id - b.id);
        moveTask(id, st.id, nextId ? Math.max(0, full.findIndex(t => t.id === nextId)) : full.length);
      };
      board.append(col);
    });
    host.append(board);
  }

  /* ---------- lista ---------- */
  function renderList(host) {
    const order = Object.fromEntries(STATUS.map((s, i) => [s.id, i]));
    const vis = visible().sort((a, b) => order[a.status] - order[b.status] || (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.position - b.position);
    const list = h('div', { class: 'tlist' }, h('div', { class: 'lrow lhead' }, h('span', {}), h('span', {}, 'Tarefa'), h('span', {}, 'Status'), h('span', {}, 'Responsável'), h('span', {}, 'Prioridade'), h('span', {}, 'Prazo')));
    vis.forEach(t => {
      const st = h('select', { class: 'stsel', style: `--c:${SMAP[t.status].c}`, onclick: e => e.stopPropagation(), onchange: e => moveTask(t.id, e.target.value, 9999) }, ...STATUS.map(s => h('option', { value: s.id }, s.n)));
      st.value = t.status;
      const r = h('div', { class: 'lrow' + (t.status === 'done' ? ' isdone' : ''), onclick: () => openTask(t.id) },
        h('button', { class: 'chk' + (t.status === 'done' ? ' on' : ''), title: 'Concluir', onclick: e => { e.stopPropagation(); toggleDone(t); } }, t.status === 'done' ? pic('done', 'sm') : null),
        h('span', { class: 'lt' }, t.title, projChip(project(t.project_id))), st,
        h('span', { class: 'lw' }, ...(member(t.assignee_id) ? [avatar(member(t.assignee_id), 'sm'), ' ' + member(t.assignee_id).name.split(' ')[0]] : ['—'])),
        prioChip(t.priority), dueBadge(t) || h('span', { class: 'muted' }, '—'));
      list.append(r);
    });
    if (!vis.length) list.append(h('div', { class: 'colempty' }, 'Nenhuma tarefa com esses filtros.'));
    host.append(list);
  }

  /* ---------- calendario ---------- */
  function renderCalendar(host) {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
    const vis = visible().filter(t => t.due_date);
    const nav = h('div', { class: 'calnav' },
      h('button', { class: 'btn', onclick: () => { calMonth = new Date(y, m - 1, 1); draw(); } }, '‹'),
      h('b', {}, new Date(y, m, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })),
      h('button', { class: 'btn', onclick: () => { calMonth = new Date(y, m + 1, 1); draw(); } }, '›'),
      h('button', { class: 'btn', onclick: () => { calMonth = new Date(); calMonth.setDate(1); draw(); } }, 'Hoje'));
    const grid = h('div', { class: 'calgrid' }, ...WD.map(d => h('div', { class: 'calwd' }, d)));
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), ds = ymd(d);
      const items = vis.filter(t => t.due_date === ds);
      const cell = h('div', { class: 'calcell' + (d.getMonth() !== m ? ' other' : '') + (ds === todayStr() ? ' today' : '') },
        h('span', { class: 'dn' }, String(d.getDate())),
        ...items.slice(0, 3).map(t => h('div', { class: 'calchip' + (t.status === 'done' ? ' isdone' : ''), style: `--pc:${PMAP[t.priority].c}`, draggable: 'true', title: t.title,
          onclick: e => { e.stopPropagation(); openTask(t.id); },
          ondragstart: e => { e.dataTransfer.setData('text/plain', String(t.id)); } }, t.title)),
        items.length > 3 ? h('small', { class: 'muted' }, `+${items.length - 3} mais`) : null);
      cell.onclick = () => openTask(null, { due_date: ds });
      cell.ondragover = e => { e.preventDefault(); cell.classList.add('over'); };
      cell.ondragleave = () => cell.classList.remove('over');
      cell.ondrop = async e => {
        e.preventDefault(); cell.classList.remove('over');
        const t = D.tasks.find(x => x.id === +e.dataTransfer.getData('text/plain')); if (!t || t.due_date === ds) return;
        try { await api('task_save', { body: { ...bodyOf(t), due_date: ds } }); toast('Prazo movido para ' + short(ds)); await refresh(); } catch (ex) { toast(ex.message); }
      };
      grid.append(cell);
    }
    host.append(nav, grid);
  }

  /* ---------- aba Tarefas ---------- */
  function draw() {
    const host = $('#pview'); if (!host) return;
    host.textContent = '';
    ({ board: renderBoard, list: renderList, cal: renderCalendar })[F.view](host);
    const open = visible().filter(t => t.status !== 'done').length;
    const c = $('#pcount'); if (c) const n = visible().length; c.textContent = `${n} tarefa${n === 1 ? '' : 's'} · ${open} em aberto`;
  }
  function toolbar() {
    const sel = (opts, val, fn) => { const e = h('select', { class: 'fsel', onchange: ev => { fn(ev.target.value); draw(); renderProjects(); } }, ...opts.map(([v, l]) => h('option', { value: v }, l))); e.value = val; return e; };
    const q = h('input', { class: 'fsearch', type: 'search', placeholder: 'Buscar tarefas…', value: F.q, 'aria-label': 'Buscar tarefas' });
    q.oninput = () => { F.q = q.value; draw(); };
    const seg = h('div', { class: 'seg vseg' }, ...[['board', 'Quadro', 'kanban'], ['list', 'Lista', 'list'], ['cal', 'Calendário', 'calendar']].map(([v, l, ic]) => {
      const b = h('button', { type: 'button', class: F.view === v ? 'on' : '', onclick: () => { F.view = v; store.set('tview', v); seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); draw(); } }, pic(ic, 'sm'), h('span', {}, l));
      return b;
    }));
    return h('div', { class: 'ptools' }, q,
      sel([['', 'Todos os projetos'], ...D.projects.map(p => [String(p.id), p.name])], F.project, v => { F.project = v; }),
      sel([['', 'Todos os responsáveis'], ['me', 'Minhas tarefas'], ['none', 'Sem responsável'], ...D.members.map(m => [String(m.id), m.name])], F.who, v => { F.who = v; }),
      sel([['', 'Qualquer prioridade'], ...PRIO.map(p => [p.id, p.n])], F.prio, v => { F.prio = v; }), seg);
  }
  async function renderTasks() {
    await load();
    S.setView(h('div', { class: 'planner' },
      h('div', { class: 'phead' }, h('h1', { class: 'ttl-ic' }, pic('kanban', 'lg'), 'Tarefas'), h('span', { id: 'pcount', class: 'muted' }),
        h('button', { class: 'btn primary', onclick: () => openTask(null) }, pic('add', 'sm'), ' Nova tarefa')),
      toolbar(), h('div', { id: 'pview', class: 'pview' })));
    draw();
  }

  /* ---------- projetos (menu lateral) ---------- */
  function renderProjects() {
    const box = $('#projList'); if (!box) return;
    const open = id => D.tasks.filter(t => (id === '' ? true : String(t.project_id) === id) && t.status !== 'done').length;
    const item = (id, name, color) => h('div', { class: 'pitem' + (F.project === id ? ' on' : ''), onclick: () => { F.project = id; if (S.section() !== 'tasks') S.go('tasks'); else { renderTasks(); } renderProjects(); } },
      h('i', { style: `background:${color}` }), h('span', { class: 'pn' }, name), h('small', {}, String(open(id))),
      id === '' ? null : h('span', { class: 'pacts' },
        h('button', { title: 'Editar projeto', onclick: e => { e.stopPropagation(); editProject(D.projects.find(p => String(p.id) === id)); } }, pic('edit', 'sm')),
        h('button', { title: 'Excluir projeto', onclick: e => { e.stopPropagation(); delProject(D.projects.find(p => String(p.id) === id)); } }, pic('trash', 'sm'))));
    box.replaceChildren(item('', 'Todos os projetos', '#8a94a6'), ...D.projects.map(p => item(String(p.id), p.name, p.color)));
  }
  async function editProject(p) {
    const v = await ask(p ? 'Editar projeto' : 'Novo projeto', [
      { name: 'name', label: 'Nome do projeto', value: p ? p.name : '', maxlength: 60, required: true },
      { name: 'color', label: 'Cor', type: 'color', value: p ? p.color : COLORS[D.projects.length % COLORS.length] },
    ], 'Salvar');
    if (!v) return;
    try { await api('project_save', { body: { id: p ? p.id : undefined, ...v } }); await refresh(); if (S.section() === 'tasks') renderTasks(); } catch (ex) { toast(ex.message); }
  }
  async function delProject(p) {
    if (!await ask('Excluir projeto?', [], 'Excluir', `As tarefas de “${p.name}” continuam existindo, mas ficam sem projeto.`)) return;
    try { await api('project_delete', { body: { id: p.id } }); if (F.project === String(p.id)) F.project = ''; await refresh(); if (S.section() === 'tasks') renderTasks(); } catch (ex) { toast(ex.message); }
  }

  /* ---------- aba Inicio (painel) ---------- */
  const countUp = (el, n) => {
    const t0 = performance.now();
    const step = t => { const k = Math.min(1, (t - t0) / 700); el.textContent = String(Math.round(n * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  const kpi = (n, label, ic, tone, go) => {
    const b = h('b', {}, '0');
    const el = h('button', { class: 'kpi ' + tone, onclick: go }, pic(ic, 'lg'), h('div', {}, b, h('small', {}, label)));
    countUp(b, n); return el;
  };
  function miniTask(t) {
    return h('div', { class: 'mt' + (t.status === 'done' ? ' isdone' : ''), onclick: () => openTask(t.id) },
      h('button', { class: 'chk' + (t.status === 'done' ? ' on' : ''), onclick: e => { e.stopPropagation(); toggleDone(t); } }, t.status === 'done' ? pic('done', 'sm') : null),
      h('span', { class: 'mtt' }, t.title), projChip(project(t.project_id)), dueBadge(t));
  }
  async function renderHome() {
    await load();
    let act = []; try { act = (await api('activity')).items; } catch { /* sem atividade */ }
    const u = me(), today = todayStr(), now = new Date(), hr = now.getHours();
    const greet = hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';
    const mine = D.tasks.filter(t => t.assignee_id === u.id), open = mine.filter(t => t.status !== 'done');
    const overdue = open.filter(t => t.due_date && t.due_date < today);
    const week = open.filter(t => t.due_date && t.due_date >= today && dayDiff(t.due_date) <= 7);
    const doneWeek = mine.filter(t => t.status === 'done' && t.completed_at && D.now - t.completed_at < 7 * 86400);
    const all = D.tasks, doneAll = all.filter(t => t.status === 'done').length;
    const pct = all.length ? Math.round(100 * doneAll / all.length) : 0;

    const quickTitle = h('input', { placeholder: 'O que precisa ser feito? Tecle Enter para criar', maxlength: 200, 'aria-label': 'Nova tarefa rápida' });
    const quickDue = h('input', { type: 'date', 'aria-label': 'Prazo' });
    const quick = h('form', { class: 'quick', onsubmit: async e => {
      e.preventDefault(); const v = quickTitle.value.trim(); if (!v) return;
      try {
        await api('task_save', { body: { title: v, status: 'todo', priority: 'medium', assignee_id: u.id, project_id: D.projects[0] ? D.projects[0].id : null, due_date: quickDue.value || null } });
        toast('Tarefa criada'); renderHome();
      } catch (ex) { toast(ex.message); }
    } }, pic('add'), quickTitle, quickDue, h('button', { class: 'btn primary' }, 'Adicionar'),
    h('button', { type: 'button', class: 'btn', onclick: () => openTask(null) }, 'Mais detalhes'));

    // distribuicao por status
    const total = Math.max(1, all.length);
    const dist = h('div', { class: 'card' }, h('h3', {}, 'Andamento da equipe'),
      h('div', { class: 'stack' }, ...STATUS.map(s => { const n = all.filter(t => t.status === s.id).length; return n ? h('i', { style: `width:${100 * n / total}%;background:${s.c}`, title: `${s.n}: ${n}` }) : null; })),
      h('div', { class: 'legend' }, ...STATUS.map(s => h('span', {}, h('i', { style: `background:${s.c}` }), `${s.n} `, h('b', {}, String(all.filter(t => t.status === s.id).length))))),
      h('div', { class: 'ring', style: `--p:${pct}` }, h('b', {}, pct + '%'), h('small', {}, 'concluído')));

    // conclusoes por dia
    const days = [...Array(14)].map((_, i) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13 + i); return { d, n: 0, s: ymd(d) }; });
    all.filter(t => t.completed_at).forEach(t => { const k = ymd(new Date(t.completed_at * 1000)); const x = days.find(d => d.s === k); if (x) x.n++; });
    const max = Math.max(1, ...days.map(d => d.n));
    const thr = h('div', { class: 'card' }, h('h3', {}, 'Conclusões nos últimos 14 dias'),
      h('div', { class: 'bars' }, ...days.map(d => h('div', { class: 'bar', title: `${short(d.s)}: ${d.n}` }, h('i', { style: `height:${Math.max(4, 100 * d.n / max)}%;opacity:${d.n ? 1 : .25}` }), h('small', {}, String(d.d.getDate()))))));

    // carga por membro
    const load_ = h('div', { class: 'card' }, h('h3', {}, 'Carga da equipe (em aberto)'),
      ...D.members.map(m => {
        const mo = all.filter(t => t.assignee_id === m.id && t.status !== 'done'), mx = Math.max(1, ...D.members.map(x => all.filter(t => t.assignee_id === x.id && t.status !== 'done').length));
        return h('div', { class: 'wl-row' }, avatar(m, 'sm'), h('span', { class: 'wn' }, m.name.split(' ')[0]),
          h('div', { class: 'wbar' }, ...PRIO.slice().reverse().map(p => { const n = mo.filter(t => t.priority === p.id).length; return n ? h('i', { style: `width:${100 * n / mx}%;background:${p.c}`, title: `${p.n}: ${n}` }) : null; })),
          h('b', {}, String(mo.length)));
      }),
      h('div', { class: 'legend' }, ...PRIO.map(p => h('span', {}, h('i', { style: `background:${p.c}` }), p.n))));

    const focus = open.slice().sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || PRIO.findIndex(p => p.id === b.priority) - PRIO.findIndex(p => p.id === a.priority)).slice(0, 8);
    const focusCard = h('div', { class: 'card wide' }, h('h3', {}, pic('target'), ' Meu foco'),
      ...(focus.length ? focus.map(miniTask) : [h('div', { class: 'colempty' }, mine.length ? 'Tudo em dia. Bom trabalho!' : 'Você ainda não tem tarefas. Crie uma acima ou peça para alguém atribuir.')]),
      focus.length ? h('button', { class: 'link more', onclick: () => { F.who = 'me'; S.go('tasks'); } }, 'Ver todas as minhas tarefas →') : null);

    const feed = h('div', { class: 'card' }, h('h3', {}, pic('timer'), ' Atividade recente'),
      ...(act.length ? act.slice(0, 10).map(a => h('div', { class: 'act-row' }, avatar(member(a.user_id) || { id: a.user_id || 0, name: a.name || '?' }, 'sm'),
        h('div', {}, h('span', {}, h('b', {}, (a.name || 'Alguém').split(' ')[0]), ' ' + a.text), h('small', {}, ago(a.ts))))) : [h('div', { class: 'colempty' }, 'Sem atividade ainda.')]));

    S.setView(h('div', { class: 'dash' },
      h('div', { class: 'hello' }, h('div', {}, h('h1', {}, `${greet}, ${u.name.split(' ')[0]}`),
        h('p', { class: 'muted' }, now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))), pic('home', 'xl')),
      quick,
      h('div', { class: 'kpis' },
        kpi(open.length, 'Minhas tarefas abertas', 'checklist', 'blue', () => { F.who = 'me'; S.go('tasks'); }),
        kpi(overdue.length, 'Atrasadas', 'hourglass', overdue.length ? 'red' : 'green', () => { F.who = 'me'; S.go('tasks'); }),
        kpi(week.length, 'Vencem em 7 dias', 'calendar', 'amber', () => { F.who = 'me'; F.view = 'cal'; S.go('tasks'); }),
        kpi(doneWeek.length, 'Concluídas na semana', 'trophy', 'green', () => { F.who = 'me'; S.go('tasks'); })),
      h('div', { class: 'dgrid' }, focusCard, dist, feed, thr, load_)));
  }

  /* ---------- registro ---------- */
  S.register('home', { render: renderHome });
  S.register('tasks', { render: renderTasks, ctx: renderProjects });
  S.openTask = openTask;
  $('#newTaskBtn').onclick = () => openTask(null);
  $('#homeNewTask').onclick = () => openTask(null);
  $('#newProjectBtn').onclick = () => editProject(null);
  $('#homeToTasks').onclick = () => { F.who = ''; F.project = ''; S.go('tasks'); };
  $('#homeToNotes').onclick = () => S.go('notes');
  $('#homeToTeam').onclick = () => S.go('team');
});
