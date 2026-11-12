-- =========================================================
-- Hope Education — update 003: admin portal (admin logins kept in a table)
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER schema.sql and 002_payment.sql. Safe to run again.
--
-- ADDING AN ADMIN
--   Dashboard → Table Editor → admins → Insert row
--     admin_id   = A001          (letters, numbers, - or _)
--     admin_name = their name
--     password   = type the password normally
--   When you save, the password is turned into a secure one-way hash automatically,
--   so the table never keeps the readable password. To change a password, type a new
--   one into the password cell. To remove access, untick "active" or delete the row.
--
-- HOW SIGN-IN WORKS
--   admin.html sends the Admin ID + password to admin_login(). If they match, it returns
--   a random session token (valid 12 hours). The portal sends that token with every
--   request, and the database rules only allow admin actions for a valid token.
--   After 5 wrong passwords an Admin ID is locked for 15 minutes.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

-- 1. Admins -------------------------------------------------------------
create table if not exists public.admins (
  admin_id   text primary key check (admin_id ~ '^[A-Za-z0-9_-]{2,30}$'),
  admin_name text not null check (char_length(admin_name) between 1 and 100),
  password   text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
-- (if an earlier version of this file was run, bring the table up to date)
alter table public.admins add column if not exists password      text;
alter table public.admins add column if not exists failed_logins integer not null default 0;
alter table public.admins add column if not exists locked_until  timestamptz;
alter table public.admins add column if not exists last_login_at timestamptz;
drop policy if exists "Admins read own record" on public.admins;   -- must go before user_id is dropped
alter table public.admins drop column if exists user_id;

-- Nobody can read the admins table through the website, not even admins.
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

-- Hash the password automatically whenever it is typed in or changed.
create or replace function public.admins_hash_password()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.password is null or char_length(new.password) < 8 then
    raise exception 'Admin password must be at least 8 characters';
  end if;
  -- Already a bcrypt hash (unchanged on update)? Leave it alone.
  if tg_op = 'UPDATE' and new.password = old.password then
    return new;
  end if;
  if new.password !~ '^\$2[abxy]\$\d\d\$' then
    new.password := extensions.crypt(new.password, extensions.gen_salt('bf', 10));
  end if;
  new.failed_logins := 0;
  new.locked_until := null;
  return new;
end;
$$;

drop trigger if exists admins_hash_password on public.admins;
create trigger admins_hash_password
  before insert or update of password on public.admins
  for each row execute function public.admins_hash_password();

-- 2. Sessions -----------------------------------------------------------
create table if not exists public.admin_sessions (
  token_hash text primary key,                 -- sha256 of the token; the token itself is never stored
  admin_id   text not null references public.admins (admin_id) on delete cascade on update cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.admin_sessions enable row level security;
revoke all on public.admin_sessions from anon, authenticated;

-- Admin ID of the request's session token (sent in the "x-admin-token" header), or null.
create or replace function public.current_admin_id()
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.admin_id
    from public.admin_sessions s
    join public.admins a on a.admin_id = s.admin_id
   where s.token_hash = encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-admin-token', ''), 'sha256'), 'hex')
     and s.expires_at > now()
     and a.active
   limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_admin_id() is not null;
$$;
grant execute on function public.current_admin_id() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- Sign in: returns {token, admin_id, admin_name, expires_at} or {error}.
-- (Errors are returned, not raised, so the failed-attempt counter is saved.)
create or replace function public.admin_login(p_admin_id text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin public.admins%rowtype;
  v_token text;
  v_expires timestamptz := now() + interval '12 hours';
begin
  delete from public.admin_sessions where expires_at < now();

  select * into v_admin from public.admins where lower(admin_id) = lower(trim(p_admin_id)) for update;

  if not found or not v_admin.active then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10)); -- same delay either way
    return json_build_object('error', 'Wrong Admin ID or password.');
  end if;

  if v_admin.locked_until is not null and v_admin.locked_until > now() then
    return json_build_object('error', 'Too many wrong passwords. Try again in 15 minutes.');
  end if;

  if v_admin.password <> extensions.crypt(coalesce(p_password, ''), v_admin.password) then
    update public.admins
       set failed_logins = failed_logins + 1,
           locked_until  = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else null end
     where admin_id = v_admin.admin_id;
    return json_build_object('error', 'Wrong Admin ID or password.');
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.admin_sessions (token_hash, admin_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_admin.admin_id, v_expires);

  -- update of these columns only (the password trigger is not fired)
  update public.admins set failed_logins = 0, locked_until = null, last_login_at = now()
   where admin_id = v_admin.admin_id;

  return json_build_object('token', v_token, 'admin_id', v_admin.admin_id,
                           'admin_name', v_admin.admin_name, 'expires_at', v_expires);
end;
$$;

-- Who is signed in (used when the portal is reopened).
create or replace function public.admin_me()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object('admin_id', a.admin_id, 'admin_name', a.admin_name)
    from public.admins a
   where a.admin_id = public.current_admin_id();
$$;

-- Sign out: ends this session.
create or replace function public.admin_logout()
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.admin_sessions
   where token_hash = encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-admin-token', ''), 'sha256'), 'hex');
$$;

revoke execute on function public.admin_login(text, text) from public;
revoke execute on function public.admin_me() from public;
revoke execute on function public.admin_logout() from public;
grant execute on function public.admin_login(text, text) to anon, authenticated;
grant execute on function public.admin_me() to anon, authenticated;
grant execute on function public.admin_logout() to anon, authenticated;

-- 3. Admin access to data ----------------------------------------------
-- The portal uses the website's publishable key (role "anon") plus the session token.
-- Visitors without a valid token still can only add enrolments and messages.
grant select, update, delete on public.enrolments       to anon, authenticated;
grant select, update, delete on public.contact_messages to anon, authenticated;
grant select                 on public.students         to anon, authenticated;

drop policy if exists "Admins manage enrolments" on public.enrolments;
create policy "Admins manage enrolments" on public.enrolments
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins manage contact messages" on public.contact_messages;
create policy "Admins manage contact messages" on public.contact_messages
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read students" on public.students;
create policy "Admins read students" on public.students
  for select to anon, authenticated using (public.is_admin());

drop policy if exists "Admins read payment receipts" on storage.objects;
create policy "Admins read payment receipts" on storage.objects
  for select to anon, authenticated using (bucket_id = 'payment-receipts' and public.is_admin());

-- 4. Activation: admins (portal), the service role, or the SQL Editor only
create or replace function public.activate_enrolment(p_enrolment_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enrolment public.enrolments%rowtype;
  v_student_id bigint;
begin
  if not (public.is_admin() or auth.role() = 'service_role' or session_user = 'postgres') then
    raise exception 'Only admins can activate enrolments' using errcode = '42501';
  end if;

  select * into v_enrolment from public.enrolments where id = p_enrolment_id for update;
  if not found then
    raise exception 'Enrolment % not found', p_enrolment_id;
  end if;

  if v_enrolment.student_id is not null then
    v_student_id := v_enrolment.student_id;
  else
    insert into public.students (email, student_name)
    values (v_enrolment.email, v_enrolment.student_name)
    on conflict (lower(email)) do nothing
    returning student_id into v_student_id;

    if v_student_id is null then
      select student_id into v_student_id from public.students where lower(email) = lower(v_enrolment.email);
    end if;
  end if;

  update public.enrolments
     set student_id = v_student_id,
         status = 'Active',
         payment_verified_at = coalesce(payment_verified_at, now())
   where id = p_enrolment_id;

  return v_student_id;
end;
$$;
revoke execute on function public.activate_enrolment(bigint) from public;
grant execute on function public.activate_enrolment(bigint) to anon, authenticated;

-- 5. Website settings editable by admins (package prices, QR code version)
create table if not exists public.site_settings (
  key        text primary key check (key ~ '^[a-z0-9_]{1,50}$'),
  value      text check (char_length(value) <= 2000),
  updated_at timestamptz not null default now()
);
alter table public.site_settings enable row level security;

drop policy if exists "Everyone reads site settings" on public.site_settings;
create policy "Everyone reads site settings" on public.site_settings
  for select to anon, authenticated using (true);

drop policy if exists "Admins change site settings" on public.site_settings;
create policy "Admins change site settings" on public.site_settings
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.site_settings to anon, authenticated;

insert into public.site_settings (key, value) values
  ('price_starter', null), ('price_focus', null), ('price_exam', null), ('payment_qr_version', null)
on conflict (key) do nothing;

-- Public bucket for website images (payment QR code). Anyone can view; only admins change.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-assets', 'site-assets', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Admins read site assets" on storage.objects;
create policy "Admins read site assets" on storage.objects
  for select to anon, authenticated using (bucket_id = 'site-assets' and public.is_admin());

drop policy if exists "Admins upload site assets" on storage.objects;
create policy "Admins upload site assets" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'site-assets' and public.is_admin());

drop policy if exists "Admins replace site assets" on storage.objects;
create policy "Admins replace site assets" on storage.objects
  for update to anon, authenticated using (bucket_id = 'site-assets' and public.is_admin())
  with check (bucket_id = 'site-assets' and public.is_admin());

drop policy if exists "Admins delete site assets" on storage.objects;
create policy "Admins delete site assets" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'site-assets' and public.is_admin());
