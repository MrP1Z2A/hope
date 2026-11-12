-- =========================================================
-- Hope Education — database setup for Supabase
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- It is safe to run again; it will not delete existing data.
--
-- Security model:
--   * Website visitors (publishable key) can only ADD enrolments and contact messages.
--   * Nobody can read, change or delete data through the website.
--   * Admins view and manage data in the Supabase dashboard (Table Editor / SQL Editor).
-- =========================================================

-- ---------- Students and permanent Student IDs ----------
-- Student IDs: six digits, start at 100001, go up by one, never reset or reused.
create sequence if not exists public.student_id_seq start with 100001 increment by 1 minvalue 100001;

create table if not exists public.students (
  student_id   bigint primary key default nextval('public.student_id_seq'),
  email        text not null,
  student_name text not null,
  created_at   timestamptz not null default now()
);
alter sequence public.student_id_seq owned by public.students.student_id;
create unique index if not exists students_email_key on public.students (lower(email));

-- ---------- Enrolment requests (from enrol.html) ----------
create table if not exists public.enrolments (
  id                 bigint generated always as identity primary key,
  created_at         timestamptz not null default now(),
  status             text not null default 'New request'
                     check (status in ('New request', 'Payment Pending', 'Active',
                                       'Payment Failed', 'Waitlisted', 'Cancelled')),
  student_id         bigint references public.students (student_id),

  -- Step 1: details
  student_name       text not null check (char_length(student_name) between 1 and 200),
  email              text not null check (char_length(email) between 3 and 320),
  phone              text check (char_length(phone) <= 50),
  under_18           boolean not null default false,
  guardian_name      text check (char_length(guardian_name) <= 200),
  guardian_contact   text check (char_length(guardian_contact) <= 320),

  -- Step 2: learning needs
  curriculum         text check (char_length(curriculum) <= 100),
  school_year        text check (char_length(school_year) <= 50),
  subjects           text[] not null default '{}',
  recent_grade       text check (char_length(recent_grade) <= 20),
  goal               text check (char_length(goal) <= 500),
  help_needed        text check (char_length(help_needed) <= 3000),
  preferred_times    text check (char_length(preferred_times) <= 500),

  -- Step 3: policy agreement
  policy_version     text,
  policy_agreed      boolean not null default false,
  guardian_agreed    boolean not null default false,
  policy_accepted_at timestamptz,

  -- Step 4: package
  package            text check (package in ('starter', 'focus', 'exam', 'unsure')),

  language           text check (language in ('en', 'my')),
  admin_notes        text
);

-- ---------- Contact form messages (from contact.html) ----------
create table if not exists public.contact_messages (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name       text not null check (char_length(name) between 1 and 200),
  email      text not null check (char_length(email) between 3 and 320),
  message    text not null check (char_length(message) between 1 and 5000),
  handled    boolean not null default false
);

-- ---------- Row Level Security ----------
alter table public.students         enable row level security;
alter table public.enrolments       enable row level security;
alter table public.contact_messages enable row level security;

-- Visitors may only add new rows. No select/update/delete policies exist,
-- so website visitors can never read or change anything.
drop policy if exists "Website can submit enrolments" on public.enrolments;
create policy "Website can submit enrolments" on public.enrolments
  for insert to anon, authenticated
  with check (status = 'New request' and student_id is null and admin_notes is null and policy_agreed);

drop policy if exists "Website can send contact messages" on public.contact_messages;
create policy "Website can send contact messages" on public.contact_messages
  for insert to anon, authenticated
  with check (handled = false);

revoke all on public.students, public.enrolments, public.contact_messages from anon, authenticated;
grant insert on public.enrolments, public.contact_messages to anon, authenticated;

-- ---------- Activating an enrolment (admins only) ----------
-- After the first payment is verified, run in the SQL Editor:
--     select public.activate_enrolment(<enrolment id>);
-- It finds or creates the student (by email), gives a new Student ID only to
-- new students, marks the enrolment Active and returns the Student ID.
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
     set student_id = v_student_id, status = 'Active'
   where id = p_enrolment_id;

  return v_student_id;
end;
$$;

revoke execute on function public.activate_enrolment(bigint) from public, anon, authenticated;
