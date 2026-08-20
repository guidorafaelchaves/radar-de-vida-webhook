-- Radar Life Data Engine - canonical body activities
-- Parallel storage for workouts, runs and structured body activity events.

create table if not exists body_activities (
  id uuid primary key default gen_random_uuid(),
  raw_record_id uuid references raw_records(id),
  source_id uuid not null references data_sources(id),
  device_id uuid references devices(id),
  activity_key text not null,
  activity_type text not null,
  subtype text,
  title text,
  date date,
  start_time timestamptz,
  end_time timestamptz,
  timezone text,
  distance_m double precision,
  duration_seconds integer,
  average_pace_sec_km double precision,
  best_pace_sec_km double precision,
  average_speed_kmh double precision,
  max_speed_kmh double precision,
  average_cadence_spm double precision,
  max_cadence_spm double precision,
  average_stride_cm double precision,
  vertical_oscillation_cm double precision,
  vertical_ratio_percent double precision,
  ground_contact_time_ms double precision,
  steps integer,
  calories_kcal double precision,
  average_heart_rate_bpm double precision,
  max_heart_rate_bpm double precision,
  min_heart_rate_bpm double precision,
  aerobic_training_effect double precision,
  anaerobic_training_effect double precision,
  training_load double precision,
  aerobic_efficiency double precision,
  quality_status text not null default 'valid',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(source_id, activity_key)
);

create index if not exists body_activities_type_date_idx
  on body_activities(activity_type, date, start_time);

create index if not exists body_activities_source_date_idx
  on body_activities(source_id, date, start_time);

