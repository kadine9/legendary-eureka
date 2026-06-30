-- Run this in the Supabase SQL editor (or via `supabase db push`) once,
-- against your project, before using the app.

create table if not exists public.links (
  id bigint generated always as identity primary key,
  title text not null default '',
  magnet text not null,
  created_at timestamptz not null default now()
);

-- Row Level Security. The app uses the anon/public key, so we open up
-- access to anyone with that key. If you want this vault to be private,
-- swap this out for Supabase Auth + a `user_id` column + per-user policies.
alter table public.links enable row level security;

drop policy if exists "Public read access" on public.links;
create policy "Public read access"
  on public.links for select
  using (true);

drop policy if exists "Public insert access" on public.links;
create policy "Public insert access"
  on public.links for insert
  with check (true);

drop policy if exists "Public delete access" on public.links;
create policy "Public delete access"
  on public.links for delete
  using (true);

create index if not exists links_created_at_idx on public.links (created_at desc);

-- HTTP links: a separate vault for plain http(s) links (as opposed to magnet URIs).
create table if not exists public.http_links (
  id bigint generated always as identity primary key,
  title text not null default '',
  url text not null,
  created_at timestamptz not null default now()
);

alter table public.http_links enable row level security;

drop policy if exists "Public read access" on public.http_links;
create policy "Public read access"
  on public.http_links for select
  using (true);

drop policy if exists "Public insert access" on public.http_links;
create policy "Public insert access"
  on public.http_links for insert
  with check (true);

drop policy if exists "Public delete access" on public.http_links;
create policy "Public delete access"
  on public.http_links for delete
  using (true);

create index if not exists http_links_created_at_idx on public.http_links (created_at desc);
