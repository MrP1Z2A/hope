-- =========================================================
-- Hope Education — update 005: teacher accounts and teacher portal
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER schema.sql, 002, 003 and 004. Safe to run again.
--
-- What it does:
--   1. Teacher accounts (passwords stored hashed, like admins and students).
--      Admins add teachers in the admin portal (Teachers tab), which creates a
--      temporary password. Teachers choose their own password the first time.
--      You can also add a teacher by hand: Table Editor → teachers → Insert row
--      (teacher_id, teacher_name, password typed normally — it is hashed on save).
--   2. One "Faculty" sign-in for admins and teachers: faculty_login() checks the
--      admins first, then the teachers. A Faculty ID can't be used for both.
--   3. Admins assign students to teachers, one row per subject, with an optional
--      online class link (Zoom / Google Meet). Teachers see only their own students;
--      students see their teachers and class links.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

-- 1. Teachers -----------------------------------------------------------
create table if not exists public.teachers (
  teacher_id           text primary key check (teacher_id ~ '^[A-Za-z0-9_-]{2,30}$'),
  teacher_name         text not null check (char_length(teacher_name) between 1 and 100),
  email                text check (char_length(email) <= 320),
  password             text,
  must_change_password boolean not null default true,
  active               boolean not null default true,
  failed_logins        integer not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now()
);
alter table public.teachers enable row level security;

-- Hash a password whenever one is typed in or changed.
create or replace function public.teachers_hash_password()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.password is null then return new; end if;
  if tg_op = 'UPDATE' and new.password is not distinct from old.password then return new; end if;
  if new.password !~ '^\$2[abxy]\$\d\d\$' then
    if char_length(new.password) < 8 then
      raise exception 'Teacher password must be at least 8 characters';
    end if;
    new.password := extensions.crypt(new.password, extensions.gen_salt('bf', 10));
  end if;
  new.failed_logins := 0;
  new.locked_until := null;
  return new;
end;
$$;

drop trigger if exists teachers_hash_password on public.teachers;
create trigger teachers_hash_password
  before insert or update of password on public.teachers
  for each row execute function public.teachers_hash_password();

-- A Faculty ID belongs to one person only: not both an admin and a teacher.
create or replace function public.faculty_id_unique()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'teachers' then
    if exists (select 1 from public.admins where lower(admin_id) = lower(new.teacher_id)) then
      raise exception 'Faculty ID % is already used by an admin', new.teacher_id;
    end if;
  else
    if exists (select 1 from public.teachers where lower(teacher_id) = lower(new.admin_id)) then
      raise exception 'Faculty ID % is already used by a teacher', new.admin_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists teachers_faculty_id_unique on public.teachers;
create trigger teachers_faculty_id_unique
  before insert or update of teacher_id on public.teachers
  for each row execute function public.faculty_id_unique();

drop trigger if exists admins_faculty_id_unique on public.admins;
create trigger admins_faculty_id_unique
  before insert or update of admin_id on public.admins
  for each row execute function public.faculty_id_unique();

create unique index if not exists teachers_id_lower_key on public.teachers (lower(teacher_id));

-- Admins can list teachers and change name / email / active, never the password columns.
revoke all on public.teachers from anon, authenticated;
grant select (teacher_id, teacher_name, email, active, must_change_password, last_login_at, created_at)
  on public.teachers to anon, authenticated;
grant update (teacher_name, email, active) on public.teachers to anon, authenticated;

drop policy if exists "Admins manage teachers" on public.teachers;
create policy "Admins manage teachers" on public.teachers
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

-- 2. Teacher sessions ---------------------------------------------------
create table if not exists public.teacher_sessions (
  token_hash text primary key,
  teacher_id text not null references public.teachers (teacher_id) on delete cascade on update cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.teacher_sessions enable row level security;
revoke all on public.teacher_sessions from anon, authenticated;

-- Teacher ID of the request's session token (sent in the "x-teacher-token" header), or null.
create or replace function public.current_teacher_id()
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.teacher_id
    from public.teacher_sessions s
    join public.teachers t on t.teacher_id = s.teacher_id
   where s.token_hash = encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-teacher-token', ''), 'sha256'), 'hex')
     and s.expires_at > now()
     and t.active
   limit 1;
$$;
grant execute on function public.current_teacher_id() to anon, authenticated;

-- Teacher sign-in (used by faculty_login below). Returns {token, ...} or {error}.
create or replace function public.teacher_login(p_teacher_id text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_t public.teachers%rowtype;
  v_token text;
  v_expires timestamptz := now() + interval '12 hours';
begin
  delete from public.teacher_sessions where expires_at < now();

  select * into v_t from public.teachers where lower(teacher_id) = lower(trim(p_teacher_id)) for update;

  if not found or not v_t.active or v_t.password is null then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10));
    return json_build_object('error', 'Wrong Faculty ID or password.');
  end if;

  if v_t.locked_until is not null and v_t.locked_until > now() then
    return json_build_object('error', 'Too many wrong passwords. Try again in 15 minutes.');
  end if;

  if v_t.password <> extensions.crypt(coalesce(p_password, ''), v_t.password) then
    update public.teachers
       set failed_logins = failed_logins + 1,
           locked_until  = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else null end
     where teacher_id = v_t.teacher_id;
    return json_build_object('error', 'Wrong Faculty ID or password.');
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.teacher_sessions (token_hash, teacher_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_t.teacher_id, v_expires);

  update public.teachers set failed_logins = 0, locked_until = null, last_login_at = now()
   where teacher_id = v_t.teacher_id;

  return json_build_object('token', v_token, 'teacher_id', v_t.teacher_id, 'teacher_name', v_t.teacher_name,
                           'must_change_password', v_t.must_change_password, 'expires_at', v_expires);
end;
$$;

-- One sign-in for all faculty: admins first, then teachers. Adds "role" to a successful answer.
-- A failed sign-in looks the same for admins and teachers, so it doesn't reveal which IDs are admins.
create or replace function public.faculty_login(p_faculty_id text, p_password text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := 'teacher';
  v_res jsonb;
begin
  if exists (select 1 from public.admins where lower(admin_id) = lower(trim(coalesce(p_faculty_id, '')))) then
    v_role := 'admin';
    v_res := public.admin_login(p_faculty_id, p_password)::jsonb;
  else
    v_res := public.teacher_login(p_faculty_id, p_password)::jsonb;
  end if;
  if v_res ? 'error' then
    if v_res ->> 'error' like 'Too many%' then
      return json_build_object('error', v_res ->> 'error');
    end if;
    return json_build_object('error', 'Wrong Faculty ID or password.');
  end if;
  return (v_res || jsonb_build_object('role', v_role))::json;
end;
$$;

create or replace function public.teacher_me()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object('teacher_id', t.teacher_id, 'teacher_name', t.teacher_name,
                           'must_change_password', t.must_change_password)
    from public.teachers t
   where t.teacher_id = public.current_teacher_id();
$$;

create or replace function public.teacher_logout()
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.teacher_sessions
   where token_hash = encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-teacher-token', ''), 'sha256'), 'hex');
$$;

-- Change password (needs the current one). Signs out the teacher's other devices.
create or replace function public.teacher_change_password(p_current text, p_new text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text := public.current_teacher_id();
  v_hash text;
begin
  if v_id is null then
    return json_build_object('error', 'Please sign in again.');
  end if;
  select password into v_hash from public.teachers where teacher_id = v_id;
  if v_hash <> extensions.crypt(coalesce(p_current, ''), v_hash) then
    return json_build_object('error', 'Your current password is not correct.');
  end if;
  if char_length(coalesce(p_new, '')) < 8 then
    return json_build_object('error', 'The new password must be at least 8 characters.');
  end if;
  if p_new = p_current then
    return json_build_object('error', 'Choose a password different from the current one.');
  end if;

  update public.teachers
     set password = extensions.crypt(p_new, extensions.gen_salt('bf', 10)),
         must_change_password = false
   where teacher_id = v_id;

  delete from public.teacher_sessions
   where teacher_id = v_id
     and token_hash <> encode(extensions.digest(
           coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-teacher-token', ''), 'sha256'), 'hex');

  return json_build_object('ok', true);
end;
$$;

-- 3. Admin actions: add a teacher, reset a teacher's password -----------
create or replace function public.admin_create_teacher(p_teacher_id text, p_teacher_name text, p_email text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_temp text := public.make_temp_password();
  v_id text := trim(coalesce(p_teacher_id, ''));
begin
  if not (public.is_admin() or auth.role() = 'service_role' or session_user = 'postgres') then
    raise exception 'Only admins can add teachers' using errcode = '42501';
  end if;
  if v_id !~ '^[A-Za-z0-9_-]{2,30}$' then
    raise exception 'Faculty ID must be 2–30 letters, numbers, - or _';
  end if;
  if exists (select 1 from public.teachers where lower(teacher_id) = lower(v_id)) then
    raise exception 'Faculty ID % is already used by a teacher', v_id;
  end if;
  insert into public.teachers (teacher_id, teacher_name, email, password, must_change_password)
  values (v_id, trim(p_teacher_name), nullif(trim(coalesce(p_email, '')), ''), v_temp, true);
  return json_build_object('teacher_id', v_id, 'teacher_name', trim(p_teacher_name),
                           'email', nullif(trim(coalesce(p_email, '')), ''), 'temp_password', v_temp);
end;
$$;

create or replace function public.admin_reset_teacher_password(p_teacher_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.teachers%rowtype;
  v_temp text := public.make_temp_password();
begin
  if not (public.is_admin() or auth.role() = 'service_role' or session_user = 'postgres') then
    raise exception 'Only admins can reset passwords' using errcode = '42501';
  end if;
  select * into v_t from public.teachers where teacher_id = p_teacher_id for update;
  if not found then
    raise exception 'Teacher % not found', p_teacher_id;
  end if;
  update public.teachers set password = v_temp, must_change_password = true where teacher_id = p_teacher_id;
  delete from public.teacher_sessions where teacher_id = p_teacher_id;   -- signs them out everywhere
  return json_build_object('teacher_id', v_t.teacher_id, 'teacher_name', v_t.teacher_name,
                           'email', v_t.email, 'temp_password', v_temp);
end;
$$;

-- When an admin turns a teacher off, end their sessions straight away.
create or replace function public.teachers_end_sessions_when_inactive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.active then
    delete from public.teacher_sessions where teacher_id = new.teacher_id;
  end if;
  return new;
end;
$$;
drop trigger if exists teachers_end_sessions on public.teachers;
create trigger teachers_end_sessions
  after update of active on public.teachers
  for each row execute function public.teachers_end_sessions_when_inactive();

-- 4. Which teacher teaches which student --------------------------------
create table if not exists public.teacher_students (
  id         bigint generated always as identity primary key,
  teacher_id text not null references public.teachers (teacher_id) on delete cascade on update cascade,
  student_id bigint not null references public.students (student_id) on delete cascade,
  subject    text not null check (char_length(subject) between 1 and 100),
  class_link text check (class_link is null or (class_link ~* '^https://[^\s<>"]+$' and char_length(class_link) <= 500)),
  created_at timestamptz not null default now(),
  unique (teacher_id, student_id, subject)
);
create index if not exists teacher_students_teacher_idx on public.teacher_students (teacher_id);
create index if not exists teacher_students_student_idx on public.teacher_students (student_id);
alter table public.teacher_students enable row level security;
revoke all on public.teacher_students from anon, authenticated;
grant select, insert, update, delete on public.teacher_students to anon, authenticated;

drop policy if exists "Admins manage teacher assignments" on public.teacher_students;
create policy "Admins manage teacher assignments" on public.teacher_students
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

-- Teacher portal: my students, with what they told us when they enrolled.
create or replace function public.teacher_my_students()
returns table (assignment_id bigint, student_id bigint, student_name text, email text, subject text,
               class_link text, curriculum text, school_year text, recent_grade text, goal text,
               help_needed text, preferred_times text, package text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me text := public.current_teacher_id();
begin
  if v_me is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  if (select must_change_password from public.teachers where teacher_id = v_me) then
    raise exception 'Please choose a new password first.' using errcode = '42501';
  end if;
  return query
    select a.id, s.student_id, s.student_name, s.email, a.subject, a.class_link,
           e.curriculum, e.school_year, e.recent_grade, e.goal, e.help_needed, e.preferred_times, e.package
      from public.teacher_students a
      join public.students s on s.student_id = a.student_id and s.active
      left join lateral (
        select * from public.enrolments en
         where en.student_id = s.student_id
         order by (en.status = 'Active') desc, en.created_at desc
         limit 1
      ) e on true
     where a.teacher_id = v_me
     order by s.student_name, a.subject;
end;
$$;

-- Teacher portal: set the online class link for one of my students (empty removes it).
create or replace function public.teacher_set_class_link(p_assignment_id bigint, p_link text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_teacher_id();
  v_link text := nullif(trim(coalesce(p_link, '')), '');
begin
  if v_me is null then
    return json_build_object('error', 'Please sign in again.');
  end if;
  if v_link is not null and (v_link !~* '^https://[^\s<>"]+$' or char_length(v_link) > 500) then
    return json_build_object('error', 'The class link must start with https://');
  end if;
  update public.teacher_students set class_link = v_link
   where id = p_assignment_id and teacher_id = v_me;
  if not found then
    return json_build_object('error', 'This student is not assigned to you.');
  end if;
  return json_build_object('ok', true);
end;
$$;

-- Student portal: my teachers and class links.
create or replace function public.student_my_teachers()
returns table (subject text, teacher_name text, class_link text)
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
    select a.subject, t.teacher_name, a.class_link
      from public.teacher_students a
      join public.teachers t on t.teacher_id = a.teacher_id and t.active
     where a.student_id = v_me
     order by a.subject;
end;
$$;

-- Function permissions
revoke execute on function public.teacher_login(text, text)                 from public, anon, authenticated;
revoke execute on function public.faculty_id_unique()                       from public, anon, authenticated;
revoke execute on function public.teachers_end_sessions_when_inactive()     from public, anon, authenticated;
revoke execute on function public.faculty_login(text, text)                 from public;
revoke execute on function public.teacher_me()                              from public;
revoke execute on function public.teacher_logout()                          from public;
revoke execute on function public.teacher_change_password(text, text)       from public;
revoke execute on function public.admin_create_teacher(text, text, text)    from public;
revoke execute on function public.admin_reset_teacher_password(text)        from public;
revoke execute on function public.teacher_my_students()                     from public;
revoke execute on function public.teacher_set_class_link(bigint, text)      from public;
revoke execute on function public.student_my_teachers()                     from public;
grant execute on function public.faculty_login(text, text)                  to anon, authenticated;
grant execute on function public.teacher_me()                               to anon, authenticated;
grant execute on function public.teacher_logout()                           to anon, authenticated;
grant execute on function public.teacher_change_password(text, text)        to anon, authenticated;
grant execute on function public.admin_create_teacher(text, text, text)     to anon, authenticated;
grant execute on function public.admin_reset_teacher_password(text)         to anon, authenticated;
grant execute on function public.teacher_my_students()                      to anon, authenticated;
grant execute on function public.teacher_set_class_link(bigint, text)       to anon, authenticated;
grant execute on function public.student_my_teachers()                      to anon, authenticated;
