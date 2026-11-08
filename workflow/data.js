// Único arquivo a editar para modelar o workflow da SLOM.
window.SLOM = {
  empresa: "SLOM",
  tagline: "Do Backlog ao Deploy, sem atrito.",
  resumo: "Fluxo corporativo de desenvolvimento: Kanban com WIP limitado, PR obrigatório, code review e CI/CD automatizado.",
  etapas: [
    { id: "backlog", nome: "Backlog", cor: "#64748b", wip: null,
      desc: "Ideias e demandas priorizadas pelo PO. Cada item nasce com problema, valor e critério de aceite.",
      entrada: "Ideia / demanda de cliente", saida: "Item refinado (DoR atendido)",
      checklist: ["Problema e valor descritos", "Critérios de aceite claros", "Estimativa (P/M/G)"] },
    { id: "todo", nome: "To-Do", cor: "#0ea5e9", wip: 8,
      desc: "Itens prontos para o ciclo atual, ordenados por prioridade.",
      entrada: "Planejamento do ciclo", saida: "Dev puxa o próximo item",
      checklist: ["Dependências mapeadas", "Branch nomeada: feat/ID-descricao"] },
    { id: "progress", nome: "In Progress", cor: "#8b5cf6", wip: 2,
      desc: "Desenvolvimento ativo. Limite estrito de WIP por dev: termine antes de começar.",
      entrada: "Dev puxa o card", saida: "PR aberto com testes",
      checklist: ["Commits convencionais", "Testes unitários", "Lint e build locais ok"] },
    { id: "review", nome: "Code Review / QA", cor: "#f59e0b", wip: 4,
      desc: "PR obrigatório com 1+ aprovação. CI roda testes, lint e análise; QA valida em staging.",
      entrada: "Pull Request aberto", saida: "PR aprovado + CI verde",
      checklist: ["CI verde", "1+ aprovação (CODEOWNERS)", "QA em staging", "Sem conflitos com main"] },
    { id: "done", nome: "Done", cor: "#10b981", wip: null,
      desc: "Mergeado na main e validado. Atende a Definition of Done.",
      entrada: "Merge (squash) na main", saida: "Release candidata",
      checklist: ["Docs atualizadas", "Card fechado", "Changelog gerado"] },
    { id: "deploy", nome: "Deploy", cor: "#ec4899", wip: null,
      desc: "Pipeline publica automaticamente: staging a cada merge, produção por tag com aprovação.",
      entrada: "Tag vX.Y.Z", saida: "Produção + monitoramento",
      checklist: ["Deploy automático", "Smoke test", "Rollback documentado"] }
  ],
  rituais: [
    { nome: "Daily", tempo: "15 min", foco: "Desbloqueios técnicos, não status." },
    { nome: "Planejamento", tempo: "1h", foco: "Escolher itens do ciclo conforme capacidade." },
    { nome: "Retrospectiva", tempo: "45 min", foco: "1 melhoria acionável por ciclo." }
  ],
  branches: [
    { nome: "main", desc: "Protegida. Sempre implantável." },
    { nome: "feat/*  fix/*  chore/*", desc: "Curta duração, saem da main, voltam por PR." },
    { nome: "tags vX.Y.Z", desc: "Disparam o deploy de produção." }
  ]
};
