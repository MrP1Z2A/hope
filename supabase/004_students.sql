-- =========================================================
-- Hope Education — update 004: student portal and student chat
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER schema.sql, 002_payment.sql and 003_admin.sql. Safe to run again.
--
-- What it does:
--   1. Students can sign in with their Student ID and a password (stored hashed).
--   2. "Accept payment and enrol" in the admin portal now also creates a temporary
--      password and shows it once, so the admin can email it to the student.
--      Students must choose their own password the first time they sign in.
--   3. A group chat for students. Admins can read it and remove messages.
--
-- Admins can also type a password into the students table by hand (Table Editor →
-- students → password). It is hashed automatically, like admin passwords.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

-- 1. Student logins -----------------------------------------------------
alter table public.students add column if not exists password             text;
alter table public.students add column if not exists must_change_password boolean not null default true;
alter table public.students add column if not exists active               boolean not null default true;
alter table public.students add column if not exists failed_logins        integer not null default 0;
alter table public.students add column if not exists locked_until         timestamptz;
alter table public.students add column if not exists last_login_at        timestamptz;

-- Hash a password whenever one is typed in or changed.
create or replace function public.students_hash_password()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.password is null then return new; end if;
  if tg_op = 'UPDATE' and new.password is not distinct from old.password then return new; end if;
  if new.password !~ '^\$2[abxy]\$\d\d\$' then
    if char_length(new.password) < 8 then
      raise exception 'Student password must be at least 8 characters';
    end if;
    new.password := extensions.crypt(new.password, extensions.gen_salt('bf', 10));
  end if;
  new.failed_logins := 0;
  new.locked_until := null;
  return new;
end;
$$;

drop trigger if exists students_hash_password on public.students;
create trigger students_hash_password
  before insert or update of password on public.students
  for each row execute function public.students_hash_password();

-- Website visitors and admins never read password columns directly.
revoke all on public.students from anon, authenticated;
grant select (student_id, email, student_name, created_at, active, must_change_password, last_login_at)
  on public.students to anon, authenticated;   -- still limited to admins by the policy from 003

-- Readable temporary password, e.g. "k7Qm2xPa9T" (no 0/O, 1/l/I to avoid confusion)
create or replace function public.make_temp_password()
returns text
language sql
volatile
set search_path = public, extensions
as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789',
                           1 + (get_byte(b, i) % 55), 1), '')
    from extensions.gen_random_bytes(10) b, generate_series(0, 9) i;
$$;
revoke execute on function public.make_temp_password() from public, anon, authenticated;

-- 2. Student sessions ---------------------------------------------------
create table if not exists public.student_sessions (
  token_hash text primary key,
  student_id bigint not null references public.students (student_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.student_sessions enable row level security;
revoke all on public.student_sessions from anon, authenticated;

-- Student ID of the request's session token (sent in the "x-student-token" header), or null.
create or replace function public.current_student_id()
returns bigint
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.student_id
    from public.student_sessions s
    join public.students st on st.student_id = s.student_id
   where s.token_hash = encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-student-token', ''), 'sha256'), 'hex')
     and s.expires_at > now()
     and st.active
   limit 1;
$$;
grant execute on function public.current_student_id() to anon, authenticated;

create or replace function public.student_login(p_student_id text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_student public.students%rowtype;
  v_token text;
  v_expires timestamptz := now() + interval '12 hours';
begin
  delete from public.student_sessions where expires_at < now();

  if coalesce(trim(p_student_id), '') !~ '^\d{6,12}$' then
    return json_build_object('error', 'Wrong Student ID or password.');
  end if;

  select * into v_student from public.students where student_id = trim(p_student_id)::bigint for update;

  if not found or not v_student.active or v_student.password is null then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10));
    return json_build_object('error', 'Wrong Student ID or password.');
  end if;

  if v_student.locked_until is not null and v_student.locked_until > now() then
    return json_build_object('error', 'Too many wrong passwords. Try again in 15 minutes.');
  end if;

  if v_student.password <> extensions.crypt(coalesce(p_password, ''), v_student.password) then
    update public.students
       set failed_logins = failed_logins + 1,
           locked_until  = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else null end
     where student_id = v_student.student_id;
    return json_build_object('error', 'Wrong Student ID or password.');
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.student_sessions (token_hash, student_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_student.student_id, v_expires);

  update public.students set failed_logins = 0, locked_until = null, last_login_at = now()
   where student_id = v_student.student_id;

  return json_build_object('token', v_token, 'student_id', v_student.student_id,
                           'student_name', v_student.student_name,
                           'must_change_password', v_student.must_change_password,
                           'expires_at', v_expires);
end;
$$;

create or replace function public.student_me()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object('student_id', s.student_id, 'student_name', s.student_name,
                           'must_change_password', s.must_change_password)
    from public.students s
   where s.student_id = public.current_student_id();
$$;

create or replace function public.student_logout()
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.student_sessions
   where token_hash = encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-student-token', ''), 'sha256'), 'hex');
$$;

-- Change password (needs the current one). Signs out the student's other devices.
create or replace function public.student_change_password(p_current text, p_new text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id bigint := public.current_student_id();
  v_hash text;
begin
  if v_id is null then
    return json_build_object('error', 'Please sign in again.');
  end if;
  select password into v_hash from public.students where student_id = v_id;
  if v_hash <> extensions.crypt(coalesce(p_current, ''), v_hash) then
    return json_build_object('error', 'Your current password is not correct.');
  end if;
  if char_length(coalesce(p_new, '')) < 8 then
    return json_build_object('error', 'The new password must be at least 8 characters.');
  end if;
  if p_new = p_current then
    return json_build_object('error', 'Choose a password different from the current one.');
  end if;

  update public.students
     set password = extensions.crypt(p_new, extensions.gen_salt('bf', 10)),
         must_change_password = false
   where student_id = v_id;

  delete from public.student_sessions
   where student_id = v_id
     and token_hash <> encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-student-token', ''), 'sha256'), 'hex');

  return json_build_object('ok', true);
end;
$$;

-- 3. Admin actions that create login details ----------------------------
-- Accept payment, enrol, and create a temporary password for new students.
-- Returns the login details ONCE so the admin can email them.
create or replace function public.accept_enrolment(p_enrolment_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid bigint;
  v_student public.students%rowtype;
  v_temp text;
begin
  if not (public.is_admin() or auth.role() = 'service_role' or session_user = 'postgres') then
    raise exception 'Only admins can accept enrolments' using errcode = '42501';
  end if;

  v_sid := public.activate_enrolment(p_enrolment_id);
  select * into v_student from public.students where student_id = v_sid for update;

  if v_student.password is null then
    v_temp := public.make_temp_password();
    update public.students set password = v_temp, must_change_password = true where student_id = v_sid;
  end if;

  return json_build_object('student_id', v_sid, 'student_name', v_student.student_name,
                           'email', v_student.email, 'temp_password', v_temp);
end;
$$;

-- Give a student a new temporary password (e.g. they forgot theirs).
create or replace function public.admin_reset_student_password(p_student_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student public.students%rowtype;
  v_temp text := public.make_temp_password();
begin
  if not (public.is_admin() or auth.role() = 'service_role' or session_user = 'postgres') then
    raise exception 'Only admins can reset passwords' using errcode = '42501';
  end if;
  select * into v_student from public.students where student_id = p_student_id for update;
  if not found then
    raise exception 'Student % not found', p_student_id;
  end if;
  update public.students set password = v_temp, must_change_password = true where student_id = p_student_id;
  delete from public.student_sessions where student_id = p_student_id;   -- signs them out everywhere
  return json_build_object('student_id', v_student.student_id, 'student_name', v_student.student_name,
                           'email', v_student.email, 'temp_password', v_temp);
end;
$$;

-- 4. Student chat -------------------------------------------------------
create table if not exists public.student_messages (
  id         bigint generated always as identity primary key,
  student_id bigint not null references public.students (student_id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  deleted    boolean not null default false,
  deleted_by text
);
create index if not exists student_messages_created_idx on public.student_messages (created_at desc);
alter table public.student_messages enable row level security;
revoke all on public.student_messages from anon, authenticated;

-- Admins (portal) can read the chat and hide messages.
grant select, update on public.student_messages to anon, authenticated;
drop policy if exists "Admins moderate student chat" on public.student_messages;
create policy "Admins moderate student chat" on public.student_messages
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

-- Latest messages (or only those after p_after_id), for a signed-in student.
create or replace function public.student_chat_list(p_after_id bigint default 0)
returns table (id bigint, student_id bigint, sender_name text, body text, created_at timestamptz, mine boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
begin
  if v_me is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  return query
    select m.id, m.student_id, st.student_name, m.body, m.created_at, (m.student_id = v_me)
      from (select * from public.student_messages sm
             where not sm.deleted and sm.id > coalesce(p_after_id, 0)
             order by sm.id desc limit 100) m
      join public.students st on st.student_id = m.student_id
     order by m.id asc;
end;
$$;

-- Send a message (max 10 per minute per student).
create or replace function public.student_chat_send(p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
  v_body text := trim(coalesce(p_body, ''));
  v_id bigint;
begin
  if v_me is null then
    return json_build_object('error', 'Please sign in again.');
  end if;
  if (select must_change_password from public.students where student_id = v_me) then
    return json_build_object('error', 'Please choose a new password first.');
  end if;
  if char_length(v_body) = 0 or char_length(v_body) > 1000 then
    return json_build_object('error', 'Messages must be 1 to 1000 characters.');
  end if;
  if (select count(*) from public.student_messages
       where student_id = v_me and created_at > now() - interval '1 minute') >= 10 then
    return json_build_object('error', 'You are sending messages too quickly. Please wait a moment.');
  end if;
  insert into public.student_messages (student_id, body) values (v_me, v_body) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

-- Function permissions
revoke execute on function public.student_login(text, text)               from public;
revoke execute on function public.student_me()                            from public;
revoke execute on function public.student_logout()                        from public;
revoke execute on function public.student_change_password(text, text)     from public;
revoke execute on function public.student_chat_list(bigint)               from public;
revoke execute on function public.student_chat_send(text)                 from public;
revoke execute on function public.accept_enrolment(bigint)                from public;
revoke execute on function public.admin_reset_student_password(bigint)    from public;
grant execute on function public.student_login(text, text)                to anon, authenticated;
grant execute on function public.student_me()                             to anon, authenticated;
grant execute on function public.student_logout()                         to anon, authenticated;
grant execute on function public.student_change_password(text, text)      to anon, authenticated;
grant execute on function public.student_chat_list(bigint)                to anon, authenticated;
grant execute on function public.student_chat_send(text)                  to anon, authenticated;
grant execute on function public.accept_enrolment(bigint)                 to anon, authenticated;
grant execute on function public.admin_reset_student_password(bigint)     to anon, authenticated;
