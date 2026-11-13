-- Tablas del bot de Cloudflare (prefijo zc_). No tocan las del primer bot (wa_*).
-- RLS activado y sin políticas: solo la secret key del servidor puede usarlas.

create table if not exists public.zc_conversations (
  clave            text primary key,
  telefono         text not null default '',
  modo             text not null default 'bot' check (modo in ('bot', 'humano')),
  motivo           text not null default '',
  ultimo_humano_en timestamptz,
  actualizado_en   timestamptz not null default now()
);

create table if not exists public.zc_messages (
  id          bigint generated always as identity primary key,
  clave       text not null,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists zc_messages_clave_id_idx on public.zc_messages (clave, id desc);
create index if not exists zc_messages_created_idx on public.zc_messages (created_at);

create table if not exists public.zc_events (
  evento_id   text primary key,
  created_at  timestamptz not null default now()
);
create index if not exists zc_events_created_idx on public.zc_events (created_at);

alter table public.zc_conversations enable row level security;
alter table public.zc_messages enable row level security;
alter table public.zc_events enable row level security;
