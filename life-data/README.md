# Radar Life Data Engine

Este diretorio prepara a Fase 2 do Life Data Engine sem conectar nada em producao.

Estado atual:

- migrations SQL iniciais;
- executor de migrations isolado, com checksum e transacao por arquivo;
- normalizadores canonicos isolados;
- ingestion canonica em memoria;
- repository transacional isolado para cliente Postgres generico;
- testes sinteticos;
- nenhuma importacao pelo `server.js`;
- nenhuma escrita real em banco no runtime atual;
- nenhuma alteracao no fluxo WhatsApp, Zepp, Apps Script ou dashboard atual.

Para validar localmente:

```powershell
npm run test:life-data
```

O motor de ingestion atual cria um plano em memoria:

- raw record draft;
- fingerprint idempotente;
- health measurements;
- daily summary;
- semantic events;
- financial events;
- nutrition events;
- mission events.

O repository atual persiste esse plano somente quando chamado explicitamente com um
cliente externo que exponha `query(sql, params)` ou `connect()`. Ele foi criado
como contrato transacional para testes e futura integracao, mas ainda nao e
importado pelo `server.js` nem executado pelos endpoints vivos.

O executor de migrations atual tambem e manual e isolado. Ele:

- le arquivos `life-data/migrations/*.sql`;
- cria a tabela `life_data_schema_migrations`;
- calcula checksum de cada migration;
- bloqueia migration ja aplicada se o SQL mudar;
- executa cada migration pendente dentro de `begin`/`commit`;
- faz `rollback` da migration atual quando houver erro.

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
3. testar o executor de migrations contra um banco descartavel;
4. testar o repository contra um banco descartavel;
5. criar feature flag separada para escrita canonica real;
6. manter `LIFE_DATA_ENGINE_ENABLED=false` ate o storage estar validado;
7. espelhar dados do Radar atual somente com `LIFE_DATA_SEMANTIC_MIRROR_ENABLED=true`.
