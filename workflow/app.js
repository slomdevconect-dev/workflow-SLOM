const D = window.SLOM, $ = id => document.getElementById(id);
$("tagline").textContent = D.tagline;
$("resumo").textContent = D.resumo;
$("ano").textContent = new Date().getFullYear();

const pipe = $("pipeline");
D.etapas.forEach((e, i) => {
  const b = document.createElement("button");
  b.className = "step";
  b.style.setProperty("--c", e.cor);
  b.innerHTML = `<small>${i + 1}</small><b>${e.nome}</b><small>${e.wip ? "WIP ≤ " + e.wip : "&nbsp;"}</small>`;
  b.onclick = () => show(i);
  pipe.appendChild(b);
});

function show(i) {
  const e = D.etapas[i], d = $("detalhe");
  [...pipe.children].forEach((c, j) => c.classList.toggle("on", i === j));
  d.style.setProperty("--c", e.cor);
  d.innerHTML = `<h3>${e.nome}</h3><p>${e.desc}</p>
    <div class="io"><div><span>Entrada</span>${e.entrada}</div><div><span>Saída</span>${e.saida}</div></div>
    <ul>${e.checklist.map(c => `<li>${c}</li>`).join("")}</ul>`;
}
show(0);

$("rituais").innerHTML = D.rituais.map(r =>
  `<div class="card"><b>${r.nome} · ${r.tempo}</b><span>${r.foco}</span></div>`).join("");
$("branches").innerHTML = D.branches.map(b =>
  `<div class="card"><b>${b.nome}</b><span>${b.desc}</span></div>`).join("");

const root = document.documentElement;
try { root.dataset.theme = localStorage.getItem("t") || "dark"; } catch { root.dataset.theme = "dark"; }
$("theme").onclick = () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("t", root.dataset.theme); } catch {}
};
