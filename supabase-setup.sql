-- ============================================================
--  JOBRA AI: Supabase setup
--  Run this in: Supabase Dashboard → SQL Editor → New query → Run
--  (You only run this ONCE, when you first create the project.)
-- ============================================================

-- ----------------------------------------------------------------
-- 1) TABLES
-- ----------------------------------------------------------------

-- People allowed to use Jobra. `status` is the payment seam:
-- flip it to 'active' to grant access. Stripe/manual both just set this.
create table if not exists public.subscribers (
  email       text primary key,
  full_name   text,
  status      text not null default 'active'
              check (status in ('active','inactive','past_due')),
  plan        text default 'standard',
  stripe_customer_id text,
  created_at  timestamptz not null default now()
);

-- If you created this table before adding Stripe, run this line once:
alter table public.subscribers add column if not exists stripe_customer_id text;

-- The shared pool of fresh jobs (filled by the ingestion script).
create table if not exists public.jobs (
  id           text primary key,        -- e.g. 'adzuna:1234567'
  source       text not null,           -- 'adzuna' | 'usajobs' | 'jobbank' | ...
  title        text not null,
  company      text,
  location     text,
  country      text check (country in ('US','CA')),
  is_remote    boolean default false,
  category     text,                    -- software | cybersecurity | data | devops | it | other
  seniority    text,                    -- intern | junior | mid | senior | lead | unknown
  salary_min   numeric,
  salary_max   numeric,
  currency     text,
  url          text,
  description  text,
  posted_at    timestamptz,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create index if not exists jobs_posted_at_idx on public.jobs (posted_at desc);
create index if not exists jobs_country_idx   on public.jobs (country);
create index if not exists jobs_category_idx  on public.jobs (category);

-- Each subscriber's saved filter preferences (optional, persists their feed view).
create table if not exists public.preferences (
  email        text primary key references public.subscribers(email) on delete cascade,
  keywords     text,
  countries    text[],                  -- e.g. {'US','CA'}
  categories   text[],
  remote_only  boolean default false,
  seniority    text,
  updated_at   timestamptz not null default now()
);

-- Each subscriber's parsed résumé + derived attributes (for match scoring).
-- We store only the extracted TEXT and a few fields. Tiny, and stays private to them.
create table if not exists public.profiles (
  email            text primary key references public.subscribers(email) on delete cascade,
  resume_text      text,
  skills           text[],
  years_experience numeric,
  seniority        text,
  industries       text[],
  updated_at       timestamptz not null default now()
);

-- ----------------------------------------------------------------
-- 2) ROW LEVEL SECURITY  (decides WHICH rows each user can see)
-- ----------------------------------------------------------------
alter table public.subscribers enable row level security;
alter table public.jobs        enable row level security;
alter table public.preferences enable row level security;
alter table public.profiles    enable row level security;

-- A logged-in user may read ONLY their own subscriber row.
drop policy if exists subscribers_self_read on public.subscribers;
create policy subscribers_self_read on public.subscribers
  for select to authenticated
  using ( lower(email) = lower(auth.jwt() ->> 'email') );

-- Jobs are readable ONLY by an ACTIVE subscriber. Everyone else gets nothing.
drop policy if exists jobs_active_read on public.jobs;
create policy jobs_active_read on public.jobs
  for select to authenticated
  using ( exists (
    select 1 from public.subscribers s
    where lower(s.email) = lower(auth.jwt() ->> 'email')
      and s.status = 'active'
  ) );

-- A user may read & write ONLY their own preferences row.
drop policy if exists prefs_self_all on public.preferences;
create policy prefs_self_all on public.preferences
  for all to authenticated
  using      ( lower(email) = lower(auth.jwt() ->> 'email') )
  with check ( lower(email) = lower(auth.jwt() ->> 'email') );

-- A user may read & write ONLY their own résumé profile.
drop policy if exists profiles_self_all on public.profiles;
create policy profiles_self_all on public.profiles
  for all to authenticated
  using      ( lower(email) = lower(auth.jwt() ->> 'email') )
  with check ( lower(email) = lower(auth.jwt() ->> 'email') );

-- ----------------------------------------------------------------
-- 3) GRANTS  (decides whether a role can touch the table AT ALL)
--    REQUIRED for projects created after 2026-05-30. New tables
--    are NOT auto-exposed to the API until you grant access.
--    Grants = "can this role use the table"; RLS = "which rows".
-- ----------------------------------------------------------------
grant select on public.jobs        to authenticated;
grant select on public.subscribers to authenticated;
grant select, insert, update, delete on public.preferences to authenticated;
grant select, insert, update, delete on public.profiles    to authenticated;

-- ----------------------------------------------------------------
--  APPLICATIONS  (the member's applied / saved job tracker)
-- ----------------------------------------------------------------
create table if not exists public.applications (
  email      text not null references public.subscribers(email) on delete cascade,
  job_id     text not null,
  title      text,
  company    text,
  location   text,
  url        text,
  status     text not null default 'applied'
             check (status in ('saved','applied','interviewing','offer','rejected')),
  updated_at timestamptz not null default now(),
  primary key (email, job_id)
);
alter table public.applications enable row level security;
drop policy if exists applications_self_all on public.applications;
create policy applications_self_all on public.applications
  for all to authenticated
  using      ( lower(email) = lower(auth.jwt() ->> 'email') )
  with check ( lower(email) = lower(auth.jwt() ->> 'email') );
grant select, insert, update, delete on public.applications to authenticated;

-- ----------------------------------------------------------------
--  LIVE STATS  (aggregate counts only, safe to expose publicly).
--  security definer lets it count across tables without exposing any
--  rows; it returns numbers, never personal data.
-- ----------------------------------------------------------------
create or replace function public.jobra_stats()
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'members_last_hour',  (select count(*) from subscribers  where created_at > now() - interval '1 hour'),
    'active_members',     (select count(*) from subscribers  where status = 'active'),
    'roles_today',        (select count(*) from jobs         where first_seen >= date_trunc('day', now())),
    'applications_today', (select count(*) from applications where status = 'applied' and updated_at >= date_trunc('day', now()))
  );
$$;
grant execute on function public.jobra_stats() to anon, authenticated;

-- NOTE: writes to `jobs` and `subscribers` happen only via the SERVICE ROLE
-- (the ingestion script + your admin actions), which bypasses RLS entirely.
-- The anon/authenticated roles intentionally get NO write access to them.

-- ----------------------------------------------------------------
-- 4) ADD YOURSELF AS THE FIRST SUBSCRIBER (so you can test the feed)
--    Replace the email with your own, then re-run just this line.
-- ----------------------------------------------------------------
insert into public.subscribers (email, full_name, status)
values ('you@example.com', 'Founder', 'active')
on conflict (email) do update set status = 'active';
