# Radar Life Data Engine

Este diretorio prepara a Fase 2 do Life Data Engine sem conectar nada em producao.

Estado atual:

- migrations SQL iniciais;
- normalizadores canonicos isolados;
- ingestion canonica em memoria;
- testes sinteticos;
- nenhuma importacao pelo `server.js`;
- nenhuma escrita em banco;
- nenhuma alteracao no fluxo WhatsApp, Zepp, Apps Script ou dashboard atual.

Para validar localmente:

```powershell
npm run test:life-data
```

O motor de ingestion atual cria apenas um plano em memoria:

- raw record draft;
- fingerprint idempotente;
- health measurements;
- daily summary;
- semantic events;
- financial events;
- nutrition events;
- mission events.

Endpoint experimental preparado:

```text
POST /api/life-data/plan
```

Regras:

- exige `LIFE_DATA_ENGINE_ENABLED=true`;
- exige `LIFE_DATA_INGESTION_ENABLED=true`;
- exige `RADAR_API_TOKEN` configurado e enviado;
- nao grava em banco;
- nao chama Apps Script;
- nao substitui nenhum endpoint atual.

Proximo passo tecnico, quando autorizado:

1. escolher Postgres gerenciado;
2. configurar `LIFE_DATA_DATABASE_URL` no ambiente;
3. criar um executor de migrations;
4. criar um repository que persista o plano de ingestion em transacao;
5. manter `LIFE_DATA_ENGINE_ENABLED=false` ate o storage estar validado;
6. espelhar dados do Radar atual somente com `LIFE_DATA_SEMANTIC_MIRROR_ENABLED=true`.
