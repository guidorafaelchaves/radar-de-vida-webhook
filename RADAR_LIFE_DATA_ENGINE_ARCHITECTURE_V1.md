# RADAR LIFE DATA ENGINE - ARCHITECTURE V1

Status: design inicial, sem impacto em producao.
Data: 2026-08-10
Projeto: Radar de Vida / Life Data Engine

## 1. Objetivo

O Radar de Vida hoje funciona como um sistema documental e semantico: entradas por WhatsApp, web, relogio e API sao interpretadas, enriquecidas e salvas via Google Apps Script/Google Docs. O Life Data Engine deve nascer como uma camada paralela, canonica e longitudinal, capaz de receber dados de multiplas fontes sem quebrar esse fluxo existente.

O objetivo desta arquitetura V1 e criar uma base para:

- preservar dados brutos;
- normalizar eventos e series temporais;
- registrar proveniencia;
- evitar duplicidade;
- gerar agregados diarios, semanais e mensais;
- permitir analises estatisticas antes da IA;
- cruzar sensores de saude com registros semanticos da vida;
- evoluir sem depender de um fornecedor unico como Google Fit, Zepp ou Health Connect.

## 2. Principios

1. O Radar atual continua funcionando.
2. Toda nova camada comeca atras de feature flags.
3. Nenhum dado potencialmente util deve ser descartado.
4. RAW e CANONICAL sao coisas diferentes.
5. Producao nao deve depender de refactor amplo.
6. Ingestao precisa ser idempotente.
7. Proveniencia e obrigatoria.
8. Correlacao nunca deve ser apresentada como causalidade.
9. A IA interpreta dados estruturados; ela nao substitui calculos basicos.
10. Falha em uma fonte nao pode derrubar o Radar.

## 3. Arquitetura Logica

```text
                         Radar de Vida atual
                                 |
       WhatsApp / Web / Zepp -> server.js -> Apps Script -> Google Docs
                                 |
                                 | opcional, assicrono, feature-flagged
                                 v
                       Radar Life Data Engine
                                 |
             +-------------------+-------------------+
             |                   |                   |
          Ingestion              Raw              Canonical
             |                   |                   |
             v                   v                   v
      Source adapters      raw payloads        measurements/events
             |                   |                   |
             +-------------------+-------------------+
                                 |
                                 v
                         Analytics Engine
                                 |
                                 v
                          Insight Engine
                                 |
                                 v
                    Dashboard longitudinal separado
```

## 4. Componentes

### 4.1 Source Adapters

Adaptadores de entrada por fonte. Cada adaptador conhece a API ou o formato de origem, mas nao deve espalhar essa especificidade pelo resto do sistema.

Fontes iniciais:

- radar_semantic: entradas atuais do Radar;
- zepp_health_bridge: snapshots vindos do app Android;
- health_connect: dados canonicos do Android, via app ponte;
- whatsapp_cloud: texto, imagem e audio;
- manual_web: entrada direta pelo painel.

Fontes futuras:

- Fitbit / Google Health APIs;
- Google Calendar;
- balanca inteligente;
- arquivos CSV/JSON;
- apps esportivos;
- localizacao autorizada;
- dados financeiros externos.

### 4.2 Ingestion API

Camada HTTP para receber dados brutos e eventos normalizados.

Na V1, ela deve conviver com os endpoints atuais. Nada substitui imediatamente:

- `POST /api/manual-entry`
- `POST /api/zepp-health-snapshot`
- `POST /api/zepp-text-entry`
- `POST /webhook/whatsapp`

Novos endpoints propostos, somente quando storage paralelo existir:

- `POST /api/life-data/ingest`
- `POST /api/life-data/health/snapshot`
- `POST /api/life-data/semantic-event`
- `GET /api/life-data/daily-summary`
- `GET /api/life-data/source-status`

### 4.3 Raw Store

Guarda payloads originais. Deve preservar:

- source;
- external id;
- payload original;
- headers relevantes sem segredos;
- received_at;
- checksum;
- schema_version;
- user/device/source metadata.

### 4.4 Canonical Store

Guarda dados normalizados em modelos estaveis:

- health measurements;
- daily aggregates;
- sleep sessions;
- workout sessions;
- semantic events;
- financial events;
- nutrition events;
- missions;
- insights.

### 4.5 Analytics Engine

Calcula:

- agregados diarios;
- medias moveis;
- baselines;
- anomalias;
- comparacoes periodo contra periodo;
- correlacoes observacionais.

### 4.6 Insight Engine

Transforma evidencias em insights explicaveis. Cada insight deve conter:

- tipo;
- periodo;
- metricas usadas;
- evidencia;
- confianca;
- limitacoes;
- fontes.

## 5. Feature Flags

As flags devem permitir rollback rapido sem alterar codigo em producao.

```env
LIFE_DATA_ENGINE_ENABLED=false
LIFE_DATA_STORAGE_ENABLED=false
LIFE_DATA_INGESTION_ENABLED=false
LIFE_DATA_HEALTH_ENABLED=false
LIFE_DATA_SEMANTIC_MIRROR_ENABLED=false
LIFE_DATA_DAILY_AGGREGATES_ENABLED=false
LIFE_DATA_INSIGHTS_ENABLED=false
LIFE_DATA_DASHBOARD_ENABLED=false
LIFE_DATA_WRITE_THROUGH_ENABLED=false
LIFE_DATA_DEBUG_LOGS=false
```

Comportamento esperado:

- se `LIFE_DATA_ENGINE_ENABLED=false`, nada novo roda;
- se storage falhar, o Radar atual continua salvando no Apps Script;
- se ingestao canonica falhar, registrar erro operacional sem quebrar `/api/manual-entry`, `/webhook/whatsapp` ou Zepp atual;
- dashboard novo so aparece se `LIFE_DATA_DASHBOARD_ENABLED=true`.

## 6. Storage Paralelo Recomendado

Recomendacao: PostgreSQL gerenciado.

Motivos:

- relacional robusto;
- suporta JSONB;
- indices temporais;
- constraints de unicidade;
- bom caminho futuro para TimescaleDB;
- portabilidade;
- adequado para eventos e series temporais.

Alternativas:

- Supabase Postgres: bom para comecar rapido;
- Neon Postgres: bom para serverless;
- Render Postgres: acoplamento natural com Render;
- Cloudflare D1: possivel para edge, mas menos ideal para series temporais complexas;
- Google Sheets/Docs: manter apenas como legado/documental, nao como warehouse.

## 7. Schema Canonico V1

Os nomes abaixo sao propostos. A implementacao final pode ajustar nomes, mas nao deve perder os conceitos.

### 7.1 data_sources

Registra fontes autorizadas.

Campos:

- id uuid pk;
- source_key text unique;
- source_type text;
- display_name text;
- provider text;
- status text;
- priority int;
- created_at timestamptz;
- updated_at timestamptz;
- metadata jsonb.

Exemplos:

- `whatsapp_cloud`;
- `radar_manual_web`;
- `zepp_health_bridge`;
- `health_connect`;
- `openai_analysis`.

### 7.2 devices

Registra dispositivos associados a fontes.

Campos:

- id uuid pk;
- source_id uuid;
- device_key text;
- model text;
- manufacturer text;
- owner_label text;
- status text;
- first_seen_at timestamptz;
- last_seen_at timestamptz;
- metadata jsonb.

Constraint sugerida:

- unique(source_id, device_key).

### 7.3 sync_state

Checkpoint por fonte e tipo de dado.

Campos:

- id uuid pk;
- source_id uuid;
- data_type text;
- sync_mode text;
- cursor text;
- last_requested_from timestamptz;
- last_requested_to timestamptz;
- last_success_at timestamptz;
- last_error_at timestamptz;
- last_error text;
- records_received int;
- records_inserted int;
- records_updated int;
- records_skipped int;
- metadata jsonb.

Constraint:

- unique(source_id, data_type, sync_mode).

### 7.4 raw_records

Tabela de preservacao bruta.

Campos:

- id uuid pk;
- source_id uuid;
- device_id uuid null;
- source_record_id text null;
- source_record_type text;
- occurred_at timestamptz null;
- start_time timestamptz null;
- end_time timestamptz null;
- timezone text;
- received_at timestamptz;
- payload jsonb not null;
- payload_checksum text not null;
- schema_version text;
- quality_status text default 'valid';
- metadata jsonb.

Constraints:

- unique(source_id, source_record_id) where source_record_id is not null;
- unique(source_id, payload_checksum).

### 7.5 health_measurements

Modelo canonico para observacoes simples e intervalares.

Campos:

- id uuid pk;
- raw_record_id uuid null;
- source_id uuid;
- device_id uuid null;
- metric text;
- value_numeric double precision;
- value_text text null;
- unit text;
- start_time timestamptz;
- end_time timestamptz null;
- timezone text;
- recording_method text;
- confidence double precision null;
- quality_status text default 'valid';
- metadata jsonb;
- created_at timestamptz.

Metricas iniciais:

- steps;
- distance_m;
- active_minutes;
- active_calories;
- total_calories;
- heart_rate_bpm;
- resting_heart_rate_bpm;
- spo2_percent;
- weight_kg;
- stress_score.

Indices:

- (metric, start_time);
- (source_id, metric, start_time);
- (device_id, metric, start_time).

### 7.6 health_daily

Agregado diario canonico.

Campos:

- id uuid pk;
- date date;
- timezone text;
- source_resolution text;
- steps int;
- distance_m double precision;
- active_minutes int;
- active_calories double precision;
- total_calories double precision;
- sleep_minutes int;
- deep_sleep_minutes int;
- rem_sleep_minutes int;
- awake_minutes int;
- resting_hr double precision;
- avg_hr double precision;
- max_hr double precision;
- weight_kg double precision;
- workouts_count int;
- workout_minutes int;
- data_quality_score int;
- quality_status text;
- sources jsonb;
- metadata jsonb;
- computed_at timestamptz.

Constraint:

- unique(date, timezone, source_resolution).

### 7.7 sleep_sessions

Campos:

- id uuid pk;
- raw_record_id uuid null;
- source_id uuid;
- device_id uuid null;
- session_key text;
- start_time timestamptz;
- end_time timestamptz;
- timezone text;
- duration_minutes int;
- deep_minutes int;
- rem_minutes int;
- light_minutes int;
- awake_minutes int;
- quality_score double precision null;
- quality_status text;
- metadata jsonb.

Constraint:

- unique(source_id, session_key).

### 7.8 sleep_stages

Campos:

- id uuid pk;
- sleep_session_id uuid;
- stage text;
- start_time timestamptz;
- end_time timestamptz;
- duration_minutes int;
- metadata jsonb.

### 7.9 workout_sessions

Campos:

- id uuid pk;
- raw_record_id uuid null;
- source_id uuid;
- device_id uuid null;
- workout_key text;
- type text;
- start_time timestamptz;
- end_time timestamptz;
- timezone text;
- duration_minutes int;
- distance_m double precision;
- calories double precision;
- avg_hr double precision;
- max_hr double precision;
- effort_score double precision null;
- quality_status text;
- metadata jsonb.

Constraint:

- unique(source_id, workout_key).

### 7.9.1 body_activities

Camada canonica para atividades corporais estruturadas, começando por corridas. Diferente de `health_daily`, que resume o dia, esta tabela preserva uma sessão específica e suas métricas de performance, mecânica, cardio e carga.

Campos:

- id uuid pk;
- raw_record_id uuid null;
- source_id uuid;
- device_id uuid null;
- activity_key text;
- activity_type text;
- subtype text;
- title text;
- date date;
- start_time timestamptz;
- end_time timestamptz;
- timezone text;
- distance_m double precision;
- duration_seconds int;
- average_pace_sec_km double precision;
- best_pace_sec_km double precision;
- average_speed_kmh double precision;
- max_speed_kmh double precision;
- average_cadence_spm double precision;
- max_cadence_spm double precision;
- average_stride_cm double precision;
- vertical_oscillation_cm double precision;
- vertical_ratio_percent double precision;
- ground_contact_time_ms double precision;
- steps int;
- calories_kcal double precision;
- average_heart_rate_bpm double precision;
- max_heart_rate_bpm double precision;
- min_heart_rate_bpm double precision;
- aerobic_training_effect double precision;
- anaerobic_training_effect double precision;
- training_load double precision;
- aerobic_efficiency double precision;
- quality_status text;
- metadata jsonb.

Regra de interpretação:

- pace menor é melhor;
- eficiência aeróbica V1 = velocidade média km/h dividida por frequência cardíaca média;
- evolução positiva = pace melhor com frequência cardíaca estável/menor ou eficiência maior;
- conclusões devem ser longitudinais e pessoais, não baseadas em “padrões ideais” genéricos;
- nunca gerar diagnóstico médico.

Constraint:

- unique(source_id, activity_key).

### 7.10 semantic_events

Eventos narrativos do Radar atual, normalizados para o Life Data Engine.

Campos:

- id uuid pk;
- raw_record_id uuid null;
- legacy_entry_id text null;
- source_id uuid;
- occurred_at timestamptz;
- date_hint date null;
- timezone text;
- original_text text;
- event_type text;
- domain text;
- title text;
- status text;
- confidence double precision;
- extracted_facts jsonb;
- metrics jsonb;
- tags text[];
- people jsonb;
- places jsonb;
- assets jsonb;
- quality_status text;
- metadata jsonb;

### 7.11 financial_events

Campos:

- id uuid pk;
- semantic_event_id uuid null;
- occurred_at timestamptz;
- event_type text;
- amount numeric(18,2);
- currency text default 'BRL';
- asset_ticker text null;
- asset_quantity numeric(18,8) null;
- unit_price numeric(18,8) null;
- broker text null;
- counterparty text null;
- category text;
- confidence double precision;
- metadata jsonb.

Tipos:

- expense;
- income;
- investment_buy;
- investment_sell;
- dividend;
- jcp;
- rent;
- fee;
- tax.

### 7.12 nutrition_events

Campos:

- id uuid pk;
- semantic_event_id uuid null;
- occurred_at timestamptz;
- meal_type text;
- description text;
- calories_estimated double precision;
- protein_g double precision;
- carbs_g double precision;
- fat_g double precision;
- fiber_g double precision;
- sodium_mg double precision;
- confidence double precision;
- missing_fields text[];
- metadata jsonb.

### 7.13 mission_events

Campos:

- id uuid pk;
- semantic_event_id uuid null;
- mission_key text;
- title text;
- intent text;
- status text;
- priority text;
- due_date date null;
- next_action text;
- confidence double precision;
- metadata jsonb.

Tipos de intent:

- create;
- progress;
- complete;
- fail;
- pause;
- reopen.

### 7.14 insights

Campos:

- id uuid pk;
- insight_type text;
- domain text;
- title text;
- description text;
- period_start date;
- period_end date;
- severity text;
- confidence double precision;
- evidence jsonb;
- limitations jsonb;
- sources jsonb;
- created_at timestamptz;
- expires_at timestamptz null;
- status text default 'active'.

Tipos:

- trend;
- anomaly;
- milestone;
- correlation;
- improvement;
- decline;
- consistency;
- behavioral_pattern;
- comparison.

### 7.15 baselines

Campos:

- id uuid pk;
- metric text;
- entity_key text;
- period_type text;
- period_start date;
- period_end date;
- value_avg double precision;
- value_median double precision;
- value_min double precision;
- value_max double precision;
- p10 double precision;
- p90 double precision;
- sample_count int;
- confidence double precision;
- metadata jsonb.

### 7.16 correlations

Campos:

- id uuid pk;
- metric_x text;
- metric_y text;
- period_start date;
- period_end date;
- sample_count int;
- correlation double precision;
- effect_size double precision null;
- stability_score double precision null;
- confidence double precision;
- caveats jsonb;
- evidence jsonb;
- created_at timestamptz.

## 8. Contratos de Ingestao

### 8.1 Envelope Canonico

Todo payload novo deve entrar com envelope padrao.

```json
{
  "source": "health_connect",
  "sourceRecordId": "external-id",
  "recordType": "daily_activity",
  "device": {
    "id": "amazfit-trex3-guido",
    "model": "Amazfit T-Rex 3",
    "manufacturer": "Amazfit"
  },
  "occurredAt": "2026-08-10T12:00:00-03:00",
  "startTime": "2026-08-10T00:00:00-03:00",
  "endTime": "2026-08-10T23:59:59-03:00",
  "timezone": "America/Recife",
  "recordingMethod": "automatic",
  "payload": {},
  "metadata": {}
}
```

### 8.2 Health Snapshot V1

Contrato inicial para manter compatibilidade com o app Android atual.

```json
{
  "source": "health_connect",
  "deviceId": "amazfit-trex3-guido",
  "deviceModel": "Amazfit T-Rex 3",
  "date": "2026-08-10",
  "timezone": "America/Recife",
  "steps": 8042,
  "distanceMeters": 6100,
  "activeMinutes": 67,
  "activeCalories": 520,
  "totalCalories": 2650,
  "sleep": {
    "start": "2026-08-09T23:42:00-03:00",
    "end": "2026-08-10T06:40:00-03:00",
    "durationMinutes": 418,
    "deepMinutes": 75,
    "remMinutes": 84,
    "awakeMinutes": 14
  },
  "heartRate": {
    "restingBpm": 58,
    "averageBpm": 82,
    "maxBpm": 149
  },
  "workout": {
    "type": "walking",
    "durationMinutes": 42,
    "distanceMeters": 3800,
    "calories": 240,
    "avgHeartRate": 112,
    "maxHeartRate": 141
  },
  "body": {
    "weightKg": 105.6,
    "spo2": 97
  }
}
```

### 8.3 Semantic Event V1

Contrato para espelhar entradas atuais do Radar sem depender de Google Docs.

```json
{
  "source": "radar_semantic",
  "legacyEntryId": "render_manual_api_...",
  "occurredAt": "2026-08-10T14:22:00-03:00",
  "timezone": "America/Recife",
  "originalText": "Recebi R$ 42 de MXRF11 e almocei arroz com frango.",
  "radarIntelligence": {},
  "legacyFields": {},
  "raw": {}
}
```

### 8.4 Body Activity V1 - Running

Contrato para treinos vindos de JSON criado pelo ChatGPT, screenshot do Zepp/Amazfit, Health Connect ou parser visual.

```json
{
  "source": "zepp_screenshot",
  "sourceRecordId": "run-2026-08-10",
  "recordType": "body_activity",
  "device": {
    "id": "amazfit-trex3-guido",
    "model": "Amazfit T-Rex 3",
    "manufacturer": "Amazfit"
  },
  "date": "2026-08-10",
  "timezone": "America/Recife",
  "payload": {
    "activity_type": "running",
    "distance_km": 5.02,
    "duration_seconds": 3252,
    "duration_display": "54:12",
    "average_pace_sec_km": 647,
    "average_pace_display": "10:47",
    "best_pace_sec_km": 532,
    "best_pace_display": "08:52",
    "average_speed_kmh": 5.56,
    "max_speed_kmh": 6.77,
    "average_cadence_spm": 134,
    "max_cadence_spm": 178,
    "average_stride_cm": 69,
    "vertical_oscillation_cm": 7.9,
    "vertical_ratio_percent": 11.4,
    "ground_contact_time_ms": 292,
    "steps": 7271,
    "calories_kcal": 637,
    "average_heart_rate_bpm": 138,
    "max_heart_rate_bpm": 160,
    "min_heart_rate_bpm": 83,
    "aerobic_training_effect": 3.1,
    "anaerobic_training_effect": 1.5,
    "training_load": 86
  }
}
```

## 9. Idempotencia

Regras:

- se a fonte fornecer `sourceRecordId`, usar `unique(source_id, source_record_id)`;
- se nao fornecer, gerar checksum estavel do payload normalizado;
- para snapshots diarios, usar chave composta: source + device + date + metric group;
- updates devem fazer upsert, nao insert cego;
- registros brutos nao devem ser sobrescritos sem versionamento.

Fingerprint sugerido:

```text
sha256(source + sourceRecordId + startTime + endTime + recordType)
```

Fallback:

```text
sha256(source + deviceId + date + stableJson(payload))
```

## 10. Deduplicacao Entre Fontes

Problema:

Telefone e relogio podem registrar o mesmo fenomeno.

Regra V1:

1. Preservar todas as fontes no RAW.
2. No CANONICAL diario, escolher fonte primaria por metrica.
3. Guardar fontes descartadas ou secundarias em `sources`.
4. Nunca somar passos de telefone + relogio sem reconciliacao.

Prioridade inicial sugerida:

```text
steps: relogio > telefone > manual
heart_rate: relogio > app > manual
sleep: relogio > app > manual
weight: balanca > manual > estimado
nutrition: manual detalhado > IA estimada > foto estimada
finance: comprovante/foto > texto manual > IA inferida
```

## 11. Timezone

Padrao do usuario:

```text
America/Recife
```

Regras:

- armazenar timestamps em `timestamptz`;
- preservar timezone original;
- agregados diarios usam timezone do usuario;
- sono pode cruzar meia-noite e deve pertencer ao dia de acordar para leitura diaria;
- eventos sem hora exata devem usar `date_hint` e baixa precisao temporal.

## 12. Data Quality

Status possiveis:

- valid;
- suspected;
- incomplete;
- duplicated;
- conflicting;
- derived;
- rejected.

Checks iniciais:

- passos negativos;
- duracao de sono impossivel;
- frequencia cardiaca fora de faixa humana plausivel;
- peso fora de faixa plausivel;
- datas futuras inesperadas;
- timezone ausente;
- duplicidade de snapshot;
- fonte desconhecida;
- unidade ausente;
- payload vazio.

Valores suspeitos nao devem ser apagados. Devem ser marcados.

## 13. Analytics V1

Primeiros calculos:

- daily summary;
- media movel 7 dias;
- media movel 30 dias;
- comparacao periodo anterior;
- baseline 30/90 dias;
- recordes pessoais;
- gaps de dados;
- tendencia simples;
- anomalias simples.

Exemplos:

- passos hoje vs media 30 dias;
- sono medio 7 dias vs 30 dias anteriores;
- FC repouso atual vs baseline;
- atividade por dia da semana;
- nutricao estimada vs gasto energetico.

## 14. Insights V1

Formato:

```json
{
  "type": "trend",
  "domain": "movement",
  "metric": "steps",
  "period": "30d",
  "severity": "info",
  "confidence": 0.84,
  "title": "Passos acima do seu padrao recente",
  "description": "Sua media de passos dos ultimos 30 dias esta 18% acima dos 30 dias anteriores.",
  "evidence": {
    "currentAvg": 8120,
    "previousAvg": 6880,
    "sampleCount": 30
  },
  "limitations": [
    "Dados dependem da sincronizacao do relogio."
  ]
}
```

## 15. Observabilidade

Eventos operacionais:

- ingestion_started;
- ingestion_completed;
- ingestion_failed;
- raw_record_inserted;
- raw_record_deduped;
- canonical_upserted;
- daily_summary_computed;
- sync_started;
- sync_completed;
- sync_failed.

Campos de log:

- source;
- data_type;
- duration_ms;
- records_received;
- records_inserted;
- records_updated;
- records_skipped;
- error_code.

Nao logar:

- tokens;
- API keys;
- payloads sensiveis completos;
- conteudo pessoal desnecessario.

## 16. Seguranca

Regras minimas:

- `RADAR_API_TOKEN` obrigatorio para endpoints de ingestao canonica;
- segredos apenas em env vars;
- nenhum token em frontend;
- payloads de saude nao devem ser expostos sem camada de acesso;
- logs sanitizados;
- possibilidade futura de revogar fonte;
- possibilidade futura de excluir dados por fonte, periodo e tipo.

## 17. Rollout Incremental

### Fase 1 - Design

Este documento.

### Fase 2 - Storage

- escolher Postgres;
- adicionar env vars sem ativar;
- criar migrations;
- criar conexao opcional;
- criar testes de schema.

### Fase 3 - Ingestion

- criar modulo `life-data/`;
- criar normalizadores;
- criar endpoint experimental atras de flag;
- testar com payload sintetico.

### Fase 4 - Espelho Semantico

- quando `LIFE_DATA_SEMANTIC_MIRROR_ENABLED=true`, espelhar entradas atuais no storage canonico;
- falha no espelho nao quebra Apps Script.

### Fase 5 - Health Canonico

- receber snapshots do app Android no storage canonico;
- manter endpoint legado funcionando;
- comparar dashboard antigo vs novo.

### Fase 6 - Aggregates

- gerar `health_daily`;
- criar baselines;
- criar primeiros insights.

### Fase 7 - Dashboard Separado

- adicionar painel "Life Data" separado;
- nao substituir tela principal.

## 18. Arquivos Que Devem Permanecer Estaveis Por Enquanto

- `server.js`, exceto adicoes pequenas e feature-flagged;
- `public/index.html`, exceto link/painel separado no futuro;
- fluxo Apps Script;
- endpoints atuais;
- app Android bridge atual;
- integracao do relogio.

## 19. Proxima Acao Recomendada

Criar Fase 2 em um branch ou commit pequeno:

1. adicionar `.env.example` com flags Life Data desligadas;
2. criar pasta `life-data/` ou `src/life-data/`;
3. criar migration SQL inicial sem executar em producao;
4. criar testes sinteticos de normalizacao;
5. manter `LIFE_DATA_ENGINE_ENABLED=false` por padrao.

## 20. Criterio de Aceitacao da Arquitetura V1

- nao altera runtime;
- nao altera producao;
- preserva Radar atual;
- define schema canonico;
- define contratos de ingestao;
- define feature flags;
- define deduplicacao;
- define caminho para storage paralelo;
- permite implementar Fase 2 sem redesenhar tudo.
