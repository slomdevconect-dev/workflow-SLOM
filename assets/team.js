/* Equipe: perfis dos membros, leitura das anotacoes e do grafo de ideias (somente leitura). */
(window.__mods = window.__mods || []).push(function (S) {
  'use strict';
  const { api, h, pic, toast } = S;
  const $ = s => document.querySelector(s);
  const U = () => S.util;

  let members = [];
  const expanded = new Set();

  async function loadTeam() { members = (await api('team')).members; }
  const fmt = t => t ? new Date(t * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
  const mine = m => m.id === S.me().id;

  function ctx() {
    const box = $('#memberList'); if (!box) return;
    box.replaceChildren(...members.map(m => h('div', { class: 'pitem', onclick: () => S.go('team', m.id) },
      U().avatar(m, 'sm'), h('span', { class: 'pn' }, m.name + (mine(m) ? ' (você)' : '')))));
  }

  /* ---------- lista de membros ---------- */
  async function renderTeam(arg) {
    await loadTeam(); ctx();
    if (arg) return profile(+arg);
    S.setView(h('div', { class: 'doc admin' },
      h('h1', { class: 'ttl-ic' }, pic('team', 'lg'), 'Equipe'),
      h('p', { class: 'muted' }, 'Veja o perfil de cada pessoa: anotações, grafo de ideias e tarefas. O acesso aos perfis é somente leitura.'),
      h('div', { class: 'mgrid' }, ...members.map(m => h('div', { class: 'mcard', onclick: () => S.go('team', m.id) },
        U().avatar(m, 'xl'),
        h('b', {}, m.name, mine(m) ? h('span', { class: 'badge mut' }, 'Você') : null),
        h('small', { class: 'muted' }, m.email),
        h('div', { class: 'mstats' },
          h('span', {}, pic('notebook', 'sm'), h('b', {}, String(m.pages)), ' anotações'),
          h('span', {}, pic('timer-play', 'sm'), h('b', {}, String(m.open_tasks)), ' em aberto'),
          h('span', {}, pic('done', 'sm'), h('b', {}, String(m.done_tasks)), ' concluídas')),
        h('small', { class: 'muted' }, 'Último acesso: ' + fmt(m.last_login)),
        h('button', { class: 'btn primary' }, 'Ver perfil'))))));
  }

  /* ---------- perfil ---------- */
  async function profile(uid, tab = 'notes', openId = null) {
    const m = members.find(x => x.id === uid);
    if (!m) { S.go('team'); return; }
    const { pages, edges } = await api('member_pages', { q: '&uid=' + uid });
    const head = h('div', { class: 'phead2' },
      U().avatar(m, 'xl'),
      h('div', {}, h('h1', {}, m.name), h('small', { class: 'muted' }, m.email + ' · último acesso: ' + fmt(m.last_login)),
        h('div', { class: 'mstats' },
          h('span', {}, pic('notebook', 'sm'), h('b', {}, String(pages.length)), ' anotações'),
          h('span', {}, pic('share', 'sm'), h('b', {}, String(edges.length)), ' conexões'),
          h('span', {}, pic('timer-play', 'sm'), h('b', {}, String(m.open_tasks)), ' tarefas em aberto'),
          h('span', {}, pic('done', 'sm'), h('b', {}, String(m.done_tasks)), ' concluídas'))),
      h('button', { class: 'btn', onclick: () => S.go('team') }, '← Equipe'));
    const tabs = h('div', { class: 'seg ptabs' }, ...[['notes', 'Anotações', 'notebook'], ['graph', 'Grafo de ideias', 'share'], ['tasks', 'Tarefas', 'kanban']].map(([id, l, ic]) =>
      h('button', { type: 'button', class: tab === id ? 'on' : '', onclick: () => profile(uid, id) }, pic(ic, 'sm'), h('span', {}, l))));
    const ro = h('div', { class: 'ronote' }, pic('lock', 'sm'), ' Somente leitura — você está vendo o perfil de ' + (mine(m) ? 'você mesmo(a) como a equipe o vê.' : m.name.split(' ')[0] + '.'));
    const body = h('div', { class: 'pbody' });
    S.setView(h('div', { class: 'doc admin' }, head, tabs, ro, body));
    if (tab === 'notes') await notesTab(body, uid, pages, openId);
    else if (tab === 'graph') graphTab(uid, pages, edges);
    else await tasksTab(body, uid);
  }

  /* ---------- anotacoes (leitura) ---------- */
  async function notesTab(body, uid, pages, openId) {
    const tree = h('nav', { class: 'rtree' }), page = h('article', { class: 'rpage' });
    const kids = pid => pages.filter(p => p.parent_id === pid).sort((a, b) => a.position - b.position || a.id - b.id);
    let curId = openId;
    const label = p => [p.icon && /^i:\d+$/.test(p.icon) && S.ICON_NAMES[+p.icon.slice(2)] ? pic(S.ICON_NAMES[+p.icon.slice(2)]) : (p.icon || pic('file')), ' ', p.title || 'Sem título'];
    const drawTree = () => {
      tree.textContent = '';
      const walk = (pid, d) => kids(pid).forEach(p => {
        const has = kids(p.id).length > 0;
        tree.append(h('div', { class: 'rrow' + (p.id === curId ? ' on' : ''), style: `padding-left:${.4 + d * 1}rem`, onclick: () => open(p.id) },
          h('button', { class: 'tw', onclick: e => { e.stopPropagation(); expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id); drawTree(); } }, has ? (expanded.has(p.id) ? '▾' : '▸') : ''),
          h('span', { class: 'tt' }, ...label(p))));
        if (expanded.has(p.id)) walk(p.id, d + 1);
      });
      walk(null, 0);
      if (!tree.children.length) tree.append(h('div', { class: 'muted', style: 'padding:.6rem' }, 'Nenhuma anotação ainda.'));
    };
    async function open(id) {
      curId = id;
      for (let a = pages.find(p => p.id === id); a && a.parent_id; a = pages.find(p => p.id === a.parent_id)) expanded.add(a.parent_id);
      drawTree();
      try {
        const { page: pg } = await api('member_page', { q: '&id=' + id });
        let blocks = []; try { blocks = JSON.parse(pg.content); } catch { /* vazio */ }
        const link = t => { const x = pages.find(p => (p.title || '').trim().toLowerCase() === t.trim().toLowerCase()); if (x) open(x.id); else toast('Página “' + t + '” não encontrada neste perfil'); };
        let n = 0;
        page.replaceChildren(
          h('div', { class: 'rhead' }, ...label(pg).slice(0, 1).map(x => h('span', { class: 'ric' }, x)), h('h2', {}, pg.title || 'Sem título')),
          h('small', { class: 'muted' }, 'Atualizada em ' + new Date(pg.updated_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })),
          ...(Array.isArray(blocks) ? blocks : []).map(b => { n = b.t === 'ol' ? n + 1 : 0; return blockEl(b, n, link); }));
      } catch (ex) { toast(ex.message); }
    }
    body.append(h('div', { class: 'reader' }, tree, page));
    const first = openId || (kids(null)[0] || {}).id;
    if (first) await open(first); else { drawTree(); page.append(h('div', { class: 'colempty' }, 'Esta pessoa ainda não tem anotações.')); }
  }
  function blockEl(b, n, onLink) {
    const d = h('div', { class: 'block t-' + b.t + (b.t === 'todo' && b.c ? ' done' : ''), ...(b.t === 'ol' ? { 'data-n': n } : {}) });
    if (b.t === 'hr') { d.append(h('hr')); return d; }
    if (b.t === 'code') { d.append(h('pre', { class: 'rcode' }, String(b.x || ''))); return d; }
    if (b.t === 'todo') d.append(h('input', { type: 'checkbox', disabled: true, checked: !!b.c }));
    const t = h('div', { class: 'txt ro' });
    const text = String(b.x || ''), re = /\[\[([^\[\]\n]{1,200})\]\]/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) t.append(text.slice(last, m.index));
      const title = m[1];
      t.append(h('a', { class: 'wl', onclick: () => onLink(title) }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) t.append(text.slice(last));
    d.append(t); return d;
  }

  /* ---------- grafo ---------- */
  function graphTab(uid, pages, edges) {
    S.drawGraph({ pages, edges, onOpen: id => profile(uid, 'notes', id), back: { label: 'Voltar ao perfil', fn: () => profile(uid, 'notes') } });
  }

  /* ---------- tarefas do membro ---------- */
  async function tasksTab(body, uid) {
    const D = await api('tasks_all');
    const mine_ = D.tasks.filter(t => t.assignee_id === uid);
    const { STATUS, PRIO, PMAP } = U();
    if (!mine_.length) { body.append(h('div', { class: 'colempty' }, 'Nenhuma tarefa atribuída.')); return; }
    body.append(...STATUS.map(s => {
      const list = mine_.filter(t => t.status === s.id);
      if (!list.length) return null;
      return h('div', { class: 'card wide', style: 'margin-bottom:.8rem' }, h('h3', {}, pic(s.ic, 'sm'), ' ' + s.n + ' ', h('span', { class: 'cnt' }, String(list.length))),
        ...list.map(t => h('div', { class: 'mt ro-t' }, h('span', { class: 'mtt' }, t.title),
          h('span', { class: 'pchip', style: `--c:${PMAP[t.priority].c}` }, PMAP[t.priority].n),
          t.due_date ? h('span', { class: 'due' }, pic('calendar', 'sm'), t.due_date.split('-').reverse().slice(0, 2).join('/')) : null)));
    }).filter(Boolean));
  }

  S.register('team', { render: renderTeam, ctx });
});
