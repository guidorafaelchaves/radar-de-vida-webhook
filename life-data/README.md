# Radar Life Data Engine

Este diretorio prepara a Fase 2 do Life Data Engine sem conectar nada em producao.

Estado atual:

- migrations SQL iniciais;
- executor de migrations isolado, com checksum e transacao por arquivo;
- normalizadores canonicos isolados;
- ingestion canonica em memoria;
- orquestrador de ingestion canonica com feature flags;
- contrato HTTP isolado para `/api/life-data/plan`;
- repository transacional isolado para cliente Postgres generico;
- testes sinteticos;
- importacao pelo `server.js` somente no endpoint experimental `/api/life-data/plan`;
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

O orquestrador `processLifeDataIngestion` une ingestion plan e repository:

- exige `LIFE_DATA_ENGINE_ENABLED=true`;
- exige `LIFE_DATA_INGESTION_ENABLED=true`;
- por padrao retorna somente `plan_only`;
- so tenta storage com `LIFE_DATA_STORAGE_ENABLED=true` e `LIFE_DATA_WRITE_THROUGH_ENABLED=true`;
- se `LIFE_DATA_FAIL_ON_STORAGE_ERROR=false`, falhas de storage voltam como aviso sem quebrar o plano;
- se `LIFE_DATA_FAIL_ON_STORAGE_ERROR=true`, falhas de storage viram erro.

Ele e usado apenas pelo endpoint experimental `/api/life-data/plan`.

O contrato HTTP `buildLifeDataPlanHttpResponse` padroniza a resposta do endpoint:

- sucesso retorna `mode`, `persisted`, `storage` e `plan`;
- ingestion desligada retorna `404` com flags exigidas;
- erro de validacao retorna `400` com `code` e `errors`;
- pode ser testado sem iniciar Express nem abrir porta.

O executor de migrations atual tambem e manual e isolado. Ele:

- le arquivos `life-data/migrations/*.sql`;
- cria a tabela `life_data_schema_migrations`;
- calcula checksum de cada migration;
- bloqueia migration ja aplicada se o SQL mudar;
- executa cada migration pendente dentro de `begin`/`commit`;
- faz `rollback` da migration atual quando houver erro.

Comandos preparados para quando houver um Postgres descartavel:

```powershell
$env:LIFE_DATA_DATABASE_URL="postgres://usuario:senha@host:5432/banco"
npm run life-data:migrations:plan
npm run life-data:migrations:dry-run
$env:LIFE_DATA_CONFIRM_RUN="yes"
npm run life-data:migrations:run
```

Notas:

- estes comandos exigem o pacote opcional `pg`;
- nao rode contra o banco de producao antes de validar em banco descartavel;
- `migrations:run` se recusa a executar sem `LIFE_DATA_CONFIRM_RUN=yes`;
- estes comandos nao iniciam o servidor e nao alteram o fluxo atual do Radar.

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
- usa `processLifeDataIngestion` e, por padrao, retorna `plan_only`.

Proximo passo tecnico, quando autorizado:

1. escolher Postgres gerenciado;
2. configurar `LIFE_DATA_DATABASE_URL` no ambiente;
3. instalar `pg` apenas no ambiente de teste de storage;
4. testar o executor de migrations contra um banco descartavel;
5. testar o repository contra um banco descartavel;
6. testar `processLifeDataIngestion` contra banco descartavel;
7. manter `LIFE_DATA_ENGINE_ENABLED=false` no runtime principal ate o storage estar validado;
8. espelhar dados do Radar atual somente com `LIFE_DATA_SEMANTIC_MIRROR_ENABLED=true`.
