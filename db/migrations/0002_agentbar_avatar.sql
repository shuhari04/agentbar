begin;

alter table agentbar_players
  add column if not exists avatar_url text not null default '';

commit;
