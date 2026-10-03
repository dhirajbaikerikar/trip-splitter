-- =====================================================================
--  Trip Splitter - Supabase schema
--  Paste this whole file into Supabase > SQL Editor > New query > Run.
--  Safe to run more than once.
--
--  HOW ACCESS WORKS (plain words)
--  * The tables are locked: nobody can read or write them directly.
--  * The app talks only through the functions at the bottom.
--  * Every function needs the trip's SECRET CODE (a long random string).
--    Whoever has the trip link (which contains the code) can view and
--    edit that trip. Nobody can list or guess other trips.
-- =====================================================================

create table if not exists public.trips (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique default replace(gen_random_uuid()::text, '-', ''),
  name        text not null check (char_length(name) between 1 and 80),
  currency    text not null default '₹' check (char_length(currency) between 1 and 5),
  start_date  date,
  end_date    date,
  created_at  timestamptz not null default clock_timestamp()
);

create table if not exists public.people (
  id          uuid primary key default gen_random_uuid(),
  seq         bigint generated always as identity,
  trip_id     uuid not null references public.trips(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  created_at  timestamptz not null default clock_timestamp()
);

create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  description   text not null check (char_length(description) between 1 and 120),
  amount        numeric(12,2) not null check (amount > 0),
  paid_by       uuid not null references public.people(id) on delete restrict,
  split_between uuid[] not null check (cardinality(split_between) >= 1),
  category      text not null default 'Other' check (char_length(category) between 1 and 30),
  spent_on      date not null default current_date,
  kind          text not null default 'expense' check (kind in ('expense','payment')),
  created_at    timestamptz not null default clock_timestamp()
);

create table if not exists public.itinerary (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips(id) on delete cascade,
  day         date not null,
  start_time  time,
  title       text not null check (char_length(title) between 1 and 120),
  notes       text check (notes is null or char_length(notes) <= 1000),
  created_at  timestamptz not null default clock_timestamp()
);

create index if not exists people_trip_idx    on public.people(trip_id);
create index if not exists expenses_trip_idx  on public.expenses(trip_id);
create index if not exists itinerary_trip_idx on public.itinerary(trip_id);

-- Lock the tables: row level security ON and NO policies = no direct access.
alter table public.trips     enable row level security;
alter table public.people    enable row level security;
alter table public.expenses  enable row level security;
alter table public.itinerary enable row level security;
revoke all on public.trips, public.people, public.expenses, public.itinerary from anon, authenticated;

-- ---------------------------------------------------------------------
--  Helper: find a trip id from its secret code (or fail)
-- ---------------------------------------------------------------------
create or replace function public._trip_id(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from trips where code = p_code;
  if v is null then raise exception 'trip_not_found'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
--  Create a trip (returns its secret code)
-- ---------------------------------------------------------------------
create or replace function public.create_trip(
  p_name text, p_currency text default '₹',
  p_start date default null, p_end date default null,
  p_people text[] default '{}')
returns text language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text; n text;
begin
  insert into trips(name, currency, start_date, end_date)
  values (btrim(p_name), coalesce(nullif(btrim(p_currency), ''), '₹'), p_start, p_end)
  returning id, code into v_id, v_code;
  foreach n in array coalesce(p_people, '{}') loop
    if btrim(n) <> '' then insert into people(trip_id, name) values (v_id, btrim(n)); end if;
  end loop;
  return v_code;
end $$;

-- ---------------------------------------------------------------------
--  Read everything about one trip as a single JSON document
-- ---------------------------------------------------------------------
create or replace function public.get_trip(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := _trip_id(p_code);
begin
  return jsonb_build_object(
    'trip', (select jsonb_build_object('id', t.id, 'name', t.name, 'currency', t.currency,
                                       'start_date', t.start_date, 'end_date', t.end_date)
             from trips t where t.id = v_id),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.seq)
                        from people p where p.trip_id = v_id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', e.id, 'description', e.description, 'amount', e.amount, 'paid_by', e.paid_by,
                    'split_between', e.split_between, 'category', e.category, 'spent_on', e.spent_on,
                    'kind', e.kind) order by e.spent_on desc, e.created_at desc)
                        from expenses e where e.trip_id = v_id), '[]'::jsonb),
    'itinerary', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', i.id, 'day', i.day, 'start_time', to_char(i.start_time, 'HH24:MI'),
                    'title', i.title, 'notes', i.notes) order by i.day, i.start_time nulls last, i.created_at)
                        from itinerary i where i.trip_id = v_id), '[]'::jsonb)
  );
end $$;

create or replace function public.update_trip(
  p_code text, p_name text, p_currency text, p_start date, p_end date)
returns void language plpgsql security definer set search_path = public as $$
begin
  update trips set name = btrim(p_name),
                   currency = coalesce(nullif(btrim(p_currency), ''), '₹'),
                   start_date = p_start, end_date = p_end
  where id = _trip_id(p_code);
end $$;

create or replace function public.delete_trip(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from trips where id = _trip_id(p_code);
end $$;

-- ---------------------------------------------------------------------
--  People
-- ---------------------------------------------------------------------
create or replace function public.add_person(p_code text, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  insert into people(trip_id, name) values (_trip_id(p_code), btrim(p_name)) returning id into v;
  return v;
end $$;

create or replace function public.rename_person(p_code text, p_person uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update people set name = btrim(p_name) where id = p_person and trip_id = _trip_id(p_code);
end $$;

create or replace function public.remove_person(p_code text, p_person uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_trip uuid := _trip_id(p_code);
begin
  if exists (select 1 from expenses e
             where e.trip_id = v_trip and (e.paid_by = p_person or p_person = any(e.split_between))) then
    raise exception 'person_in_use';
  end if;
  delete from people where id = p_person and trip_id = v_trip;
end $$;

-- ---------------------------------------------------------------------
--  Expenses (kind 'payment' = "A paid B back", used by Mark as paid)
-- ---------------------------------------------------------------------
create or replace function public.save_expense(
  p_code text, p_id uuid, p_description text, p_amount numeric, p_paid_by uuid,
  p_split uuid[], p_category text, p_date date, p_kind text default 'expense')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_trip uuid := _trip_id(p_code); v uuid; v_split uuid[];
begin
  select array_agg(distinct x) into v_split from unnest(p_split) x;
  if v_split is null or cardinality(v_split) < 1 then raise exception 'split_empty'; end if;
  if not exists (select 1 from people where id = p_paid_by and trip_id = v_trip) then
    raise exception 'payer_not_in_trip';
  end if;
  if (select count(*) from people where trip_id = v_trip and id = any(v_split)) <> cardinality(v_split) then
    raise exception 'split_person_not_in_trip';
  end if;
  if p_id is null then
    insert into expenses(trip_id, description, amount, paid_by, split_between, category, spent_on, kind)
    values (v_trip, btrim(p_description), round(p_amount, 2), p_paid_by, v_split,
            coalesce(nullif(btrim(p_category), ''), 'Other'), coalesce(p_date, current_date),
            coalesce(p_kind, 'expense'))
    returning id into v;
  else
    update expenses set description = btrim(p_description), amount = round(p_amount, 2),
           paid_by = p_paid_by, split_between = v_split,
           category = coalesce(nullif(btrim(p_category), ''), 'Other'),
           spent_on = coalesce(p_date, current_date), kind = coalesce(p_kind, 'expense')
    where id = p_id and trip_id = v_trip returning id into v;
    if v is null then raise exception 'expense_not_found'; end if;
  end if;
  return v;
end $$;

create or replace function public.delete_expense(p_code text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from expenses where id = p_id and trip_id = _trip_id(p_code);
end $$;

-- ---------------------------------------------------------------------
--  Itinerary
-- ---------------------------------------------------------------------
create or replace function public.save_itinerary(
  p_code text, p_id uuid, p_day date, p_time text, p_title text, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_trip uuid := _trip_id(p_code); v uuid; v_time time := nullif(btrim(coalesce(p_time, '')), '')::time;
begin
  if p_id is null then
    insert into itinerary(trip_id, day, start_time, title, notes)
    values (v_trip, p_day, v_time, btrim(p_title), nullif(btrim(coalesce(p_notes, '')), ''))
    returning id into v;
  else
    update itinerary set day = p_day, start_time = v_time, title = btrim(p_title),
           notes = nullif(btrim(coalesce(p_notes, '')), '')
    where id = p_id and trip_id = v_trip returning id into v;
    if v is null then raise exception 'item_not_found'; end if;
  end if;
  return v;
end $$;

create or replace function public.delete_itinerary(p_code text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from itinerary where id = p_id and trip_id = _trip_id(p_code);
end $$;

-- ---------------------------------------------------------------------
--  Let the public (anon) key call ONLY the app functions
-- ---------------------------------------------------------------------
revoke all on function public._trip_id(text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'create_trip(text,text,date,date,text[])', 'get_trip(text)',
    'update_trip(text,text,text,date,date)', 'delete_trip(text)',
    'add_person(text,text)', 'rename_person(text,uuid,text)', 'remove_person(text,uuid)',
    'save_expense(text,uuid,text,numeric,uuid,uuid[],text,date,text)', 'delete_expense(text,uuid)',
    'save_itinerary(text,uuid,date,text,text,text)', 'delete_itinerary(text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
