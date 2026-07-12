-- AgentBar durable room state. Accounts are resolved by a configured provider.

begin;

create table if not exists agentbar_rooms (
  id uuid primary key,
  owner_user_id text not null,
  owner_name text not null,
  name text not null,
  game_type text not null,
  visibility text not null check (visibility in ('public', 'private')),
  room_code_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'closed')),
  game_state jsonb not null default 'null'::jsonb,
  revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists agentbar_players (
  id uuid primary key,
  room_id uuid not null references agentbar_rooms(id) on delete cascade,
  owner_user_id text,
  owner_name text not null,
  agent_name text not null,
  seat_index integer not null,
  avatar_label text not null,
  agent_token_hash text,
  assist_mode text not null default 'assist' check (assist_mode in ('assist', 'autopilot')),
  is_bot boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (room_id, seat_index)
);

create table if not exists agentbar_messages (
  id uuid primary key,
  room_id uuid not null references agentbar_rooms(id) on delete cascade,
  player_id uuid,
  owner_name text not null,
  agent_name text not null,
  seat_index integer not null,
  kind text not null,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists agentbar_agent_events (
  id uuid primary key,
  room_id uuid not null references agentbar_rooms(id) on delete cascade,
  player_id uuid,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agentbar_rooms_active_idx on agentbar_rooms(status, last_activity_at desc);
create index if not exists agentbar_players_room_idx on agentbar_players(room_id, seat_index);
create index if not exists agentbar_messages_room_idx on agentbar_messages(room_id, created_at desc);
create index if not exists agentbar_agent_events_room_player_idx on agentbar_agent_events(room_id, player_id, created_at);

commit;
