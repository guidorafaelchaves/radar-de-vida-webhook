-- Radar Life Data Engine - initial canonical schema
-- Safe to review. Do not run in production until storage is explicitly enabled.

create extension if not exists pgcrypto;

create table if not exists data_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  source_type text not null,
  display_name text not null,
  provider text,
  status text not null default 'active',
  priority integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references data_sources(id),
  device_key text not null,
  model text,
  manufacturer text,
  owner_label text,
  status text not null default 'active',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (source_id, device_key)
);

create table if not exists sync_state (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references data_sources(id),
  data_type text not null,
  sync_mode text not null,
  cursor text,
  last_requested_from timestamptz,
  last_requested_to timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  records_received integer not null default 0,
  records_inserted integer not null default 0,
  records_updated integer not null default 0,
  records_skipped integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  unique (source_id, data_type, sync_mode)
);

create table if not exists raw_records (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references data_sources(id),
  device_id uuid references devices(id),
  source_record_id text,
  source_record_type text not null,
  occurred_at timestamptz,
  start_time timestamptz,
  end_time timestamptz,
  timezone text,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  payload_checksum text not null,
  schema_version text not null default 'life_data_v1',
  quality_status text not null default 'valid',
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists raw_records_source_record_uidx
  on raw_records(source_id, source_record_id)
  where source_record_id is not null;

create unique index if not exists raw_records_payload_checksum_uidx
  on raw_records(source_id, payload_checksum);

create index if not exists raw_records_time_idx
  on raw_records(source_id, source_record_type, start_time, occurred_at);

create table if not exists health_measurements (
  id uuid primary key default gen_random_uuid(),
  raw_record_id uuid references raw_records(id),
  source_id uuid not null references data_sources(id),
  device_id uuid references devices(id),
  metric text not null,
  value_numeric double precision,
  value_text text,
  unit text,
  start_time timestamptz not null,
  end_time timestamptz,
  timezone text,
  recording_method text,
  confidence double precision,
  quality_status text not null default 'valid',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists health_measurements_metric_time_idx
  on health_measurements(metric, start_time);

create index if not exists health_measurements_source_metric_time_idx
  on health_measurements(source_id, metric, start_time);

create table if not exists health_daily (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  timezone text not null,
  source_resolution text not null default 'resolved_primary',
  steps integer,
  distance_m double precision,
  active_minutes integer,
  active_calories double precision,
  total_calories double precision,
  sleep_minutes integer,
  deep_sleep_minutes integer,
  rem_sleep_minutes integer,
  awake_minutes integer,
  resting_hr double precision,
  avg_hr double precision,
  max_hr double precision,
  weight_kg double precision,
  workouts_count integer not null default 0,
  workout_minutes integer not null default 0,
  data_quality_score integer,
  quality_status text not null default 'valid',
  sources jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  unique(date, timezone, source_resolution)
);

create table if not exists sleep_sessions (
  id uuid primary key default gen_random_uuid(),
  raw_record_id uuid references raw_records(id),
  source_id uuid not null references data_sources(id),
  device_id uuid references devices(id),
  session_key text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  timezone text,
  duration_minutes integer,
  deep_minutes integer,
  rem_minutes integer,
  light_minutes integer,
  awake_minutes integer,
  quality_score double precision,
  quality_status text not null default 'valid',
  metadata jsonb not null default '{}'::jsonb,
  unique(source_id, session_key)
);

create table if not exists sleep_stages (
  id uuid primary key default gen_random_uuid(),
  sleep_session_id uuid not null references sleep_sessions(id) on delete cascade,
  stage text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  duration_minutes integer,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists workout_sessions (
  id uuid primary key default gen_random_uuid(),
  raw_record_id uuid references raw_records(id),
  source_id uuid not null references data_sources(id),
  device_id uuid references devices(id),
  workout_key text not null,
  type text,
  start_time timestamptz not null,
  end_time timestamptz,
  timezone text,
  duration_minutes integer,
  distance_m double precision,
  calories double precision,
  avg_hr double precision,
  max_hr double precision,
  effort_score double precision,
  quality_status text not null default 'valid',
  metadata jsonb not null default '{}'::jsonb,
  unique(source_id, workout_key)
);

create table if not exists semantic_events (
  id uuid primary key default gen_random_uuid(),
  raw_record_id uuid references raw_records(id),
  legacy_entry_id text,
  source_id uuid not null references data_sources(id),
  occurred_at timestamptz,
  date_hint date,
  timezone text,
  original_text text,
  event_type text,
  domain text,
  title text,
  status text,
  confidence double precision,
  extracted_facts jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  people jsonb not null default '[]'::jsonb,
  places jsonb not null default '[]'::jsonb,
  assets jsonb not null default '[]'::jsonb,
  quality_status text not null default 'valid',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists semantic_events_time_idx
  on semantic_events(source_id, occurred_at, date_hint);

create table if not exists financial_events (
  id uuid primary key default gen_random_uuid(),
  semantic_event_id uuid references semantic_events(id) on delete set null,
  occurred_at timestamptz,
  event_type text not null,
  amount numeric(18, 2),
  currency text not null default 'BRL',
  asset_ticker text,
  asset_quantity numeric(18, 8),
  unit_price numeric(18, 8),
  broker text,
  counterparty text,
  category text,
  confidence double precision,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists nutrition_events (
  id uuid primary key default gen_random_uuid(),
  semantic_event_id uuid references semantic_events(id) on delete set null,
  occurred_at timestamptz,
  meal_type text,
  description text,
  calories_estimated double precision,
  protein_g double precision,
  carbs_g double precision,
  fat_g double precision,
  fiber_g double precision,
  sodium_mg double precision,
  confidence double precision,
  missing_fields text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists mission_events (
  id uuid primary key default gen_random_uuid(),
  semantic_event_id uuid references semantic_events(id) on delete set null,
  mission_key text not null,
  title text not null,
  intent text not null,
  status text,
  priority text,
  due_date date,
  next_action text,
  confidence double precision,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists mission_events_key_idx
  on mission_events(mission_key, status);

create table if not exists baselines (
  id uuid primary key default gen_random_uuid(),
  metric text not null,
  entity_key text not null default 'user',
  period_type text not null,
  period_start date not null,
  period_end date not null,
  value_avg double precision,
  value_median double precision,
  value_min double precision,
  value_max double precision,
  p10 double precision,
  p90 double precision,
  sample_count integer not null default 0,
  confidence double precision,
  metadata jsonb not null default '{}'::jsonb,
  unique(metric, entity_key, period_type, period_start, period_end)
);

create table if not exists correlations (
  id uuid primary key default gen_random_uuid(),
  metric_x text not null,
  metric_y text not null,
  period_start date not null,
  period_end date not null,
  sample_count integer not null,
  correlation double precision,
  effect_size double precision,
  stability_score double precision,
  confidence double precision,
  caveats jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists insights (
  id uuid primary key default gen_random_uuid(),
  insight_type text not null,
  domain text not null,
  title text not null,
  description text not null,
  period_start date,
  period_end date,
  severity text not null default 'info',
  confidence double precision,
  evidence jsonb not null default '{}'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active'
);

create index if not exists insights_domain_period_idx
  on insights(domain, period_start, period_end, status);

