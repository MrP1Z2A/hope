-- =========================================================
-- Hope Education — update 007: homework, lesson requests, teacher messages,
-- attendance history and lesson notes
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER 006_lessons.sql. Safe to run again.
--
-- What it does:
--   1. Homework: teachers set homework for their students; students answer with
--      text and/or one file (image, PDF or Word, max 10 MB); teachers give feedback.
--      Files go in the private "homework-files" bucket, in a folder per student.
--   2. Lesson requests: students ask their teacher for a lesson time (or a make-up
--      lesson for an absence that may be rescheduled); the teacher accepts (the
--      lesson is booked) or declines with a reply.
--   3. Private messages between a student and each of their teachers. Admins can
--      read them (safeguarding: tutors only contact students through Hope Education).
--   4. Attendance history for any month, with the rescheduling rule of each absence.
-- =========================================================

-- 1. Homework ------------------------------------------------------------
create table if not exists public.homework (
  id         bigint generated always as identity primary key,
  teacher_id text not null references public.teachers (teacher_id) on delete cascade on update cascade,
  student_id bigint not null references public.students (student_id) on delete cascade,
  subject    text not null check (char_length(subject) between 1 and 100),
  title      text not null check (char_length(title) between 1 and 200),
  details    text check (char_length(details) <= 3000),
  due_at     timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists homework_student_idx on public.homework (student_id, created_at desc);
create index if not exists homework_teacher_idx on public.homework (teacher_id, created_at desc);

create table if not exists public.homework_submissions (
  homework_id  bigint primary key references public.homework (id) on delete cascade,
  student_id   bigint not null references public.students (student_id) on delete cascade,
  body         text check (char_length(body) <= 5000),
  file_path    text check (char_length(file_path) <= 300),
  file_name    text check (char_length(file_name) <= 200),
  submitted_at timestamptz not null default now(),
  feedback     text check (char_length(feedback) <= 3000),
  reviewed_at  timestamptz
);

alter table public.homework enable row level security;
alter table public.homework_submissions enable row level security;
revoke all on public.homework, public.homework_submissions from anon, authenticated;
grant select, update, delete on public.homework, public.homework_submissions to anon, authenticated;
drop policy if exists "Admins manage homework" on public.homework;
create policy "Admins manage homework" on public.homework
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admins manage homework submissions" on public.homework_submissions;
create policy "Admins manage homework submissions" on public.homework_submissions
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

-- Private bucket for homework files: <student_id>/<random>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('homework-files', 'homework-files', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'application/pdf',
              'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Students upload homework files" on storage.objects;
create policy "Students upload homework files" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'homework-files'
              and public.current_student_id() is not null
              and (storage.foldername(name))[1] = public.current_student_id()::text);

-- Is this homework file handed in to the signed-in teacher? (runs as the owner, so the
-- tables' own rules don't hide the rows)
create or replace function public.teacher_owns_homework_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.homework_submissions s
                   join public.homework h on h.id = s.homework_id
                  where s.file_path = p_name and h.teacher_id = public.current_teacher_id());
$$;
grant execute on function public.teacher_owns_homework_file(text) to anon, authenticated;

drop policy if exists "Read homework files" on storage.objects;
create policy "Read homework files" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'homework-files' and (
           public.is_admin()
        or (public.current_student_id() is not null
            and (storage.foldername(name))[1] = public.current_student_id()::text)
        or public.teacher_owns_homework_file(name)));

-- Teacher: set homework for one of my students
create or replace function public.teacher_add_homework(p_assignment_id bigint, p_title text, p_details text, p_due_at timestamptz)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_teacher_id();
  v_a public.teacher_students%rowtype;
  v_id bigint;
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  select * into v_a from public.teacher_students where id = p_assignment_id and teacher_id = v_me;
  if not found then return json_build_object('error', 'This student is not assigned to you.'); end if;
  if char_length(trim(coalesce(p_title, ''))) = 0 or char_length(p_title) > 200 then
    return json_build_object('error', 'Write a short title (up to 200 characters).');
  end if;
  if char_length(coalesce(p_details, '')) > 3000 then
    return json_build_object('error', 'Details must be 3000 characters or fewer.');
  end if;
  insert into public.homework (teacher_id, student_id, subject, title, details, due_at)
  values (v_me, v_a.student_id, v_a.subject, trim(p_title), nullif(trim(coalesce(p_details, '')), ''), p_due_at)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.teacher_delete_homework(p_homework_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_me text := public.current_teacher_id();
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  delete from public.homework where id = p_homework_id and teacher_id = v_me;
  if not found then return json_build_object('error', 'Homework not found.'); end if;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.teacher_homework()
returns table (id bigint, student_id bigint, student_name text, subject text, title text, details text,
               due_at timestamptz, created_at timestamptz, submitted_at timestamptz, body text,
               file_path text, file_name text, feedback text, reviewed_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me text := public.current_teacher_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select h.id, h.student_id, st.student_name, h.subject, h.title, h.details, h.due_at, h.created_at,
           s.submitted_at, s.body, s.file_path, s.file_name, s.feedback, s.reviewed_at
      from public.homework h
      join public.students st on st.student_id = h.student_id
      left join public.homework_submissions s on s.homework_id = h.id
     where h.teacher_id = v_me
     order by h.created_at desc
     limit 200;
end;
$$;

create or replace function public.teacher_review_homework(p_homework_id bigint, p_feedback text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_me text := public.current_teacher_id();
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  if char_length(coalesce(p_feedback, '')) > 3000 then
    return json_build_object('error', 'Feedback must be 3000 characters or fewer.');
  end if;
  update public.homework_submissions s
     set feedback = nullif(trim(coalesce(p_feedback, '')), ''), reviewed_at = now()
    from public.homework h
   where s.homework_id = p_homework_id and h.id = s.homework_id and h.teacher_id = v_me;
  if not found then return json_build_object('error', 'Nothing has been handed in for this homework yet.'); end if;
  return json_build_object('ok', true);
end;
$$;

-- Student: my homework and my answers
create or replace function public.student_homework()
returns table (id bigint, subject text, teacher_name text, title text, details text, due_at timestamptz,
               created_at timestamptz, submitted_at timestamptz, body text, file_path text, file_name text,
               feedback text, reviewed_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select h.id, h.subject, t.teacher_name, h.title, h.details, h.due_at, h.created_at,
           s.submitted_at, s.body, s.file_path, s.file_name, s.feedback, s.reviewed_at
      from public.homework h
      join public.teachers t on t.teacher_id = h.teacher_id
      left join public.homework_submissions s on s.homework_id = h.id
     where h.student_id = v_me
     order by (s.submitted_at is null) desc, h.due_at nulls last, h.created_at desc
     limit 200;
end;
$$;

-- Hand in (or replace, until the teacher has reviewed it). The file must already be
-- uploaded to homework-files/<my student id>/...
create or replace function public.student_submit_homework(p_homework_id bigint, p_body text, p_file_path text, p_file_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_path text := nullif(trim(coalesce(p_file_path, '')), '');
  v_old public.homework_submissions%rowtype;
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  if not exists (select 1 from public.homework where id = p_homework_id and student_id = v_me) then
    return json_build_object('error', 'Homework not found.');
  end if;
  if v_body is null and v_path is null then
    return json_build_object('error', 'Write an answer or attach a file.');
  end if;
  if char_length(coalesce(v_body, '')) > 5000 then
    return json_build_object('error', 'The answer must be 5000 characters or fewer.');
  end if;
  if v_path is not null and (v_path !~ ('^' || v_me::text || '/[A-Za-z0-9-]+\.[a-z0-9]{1,5}$')
                             or not exists (select 1 from storage.objects o
                                             where o.bucket_id = 'homework-files' and o.name = v_path)) then
    return json_build_object('error', 'The file could not be found. Please attach it again.');
  end if;
  select * into v_old from public.homework_submissions where homework_id = p_homework_id;
  if found and v_old.reviewed_at is not null then
    return json_build_object('error', 'Your teacher has already reviewed this homework.');
  end if;
  insert into public.homework_submissions (homework_id, student_id, body, file_path, file_name, submitted_at)
  values (p_homework_id, v_me, v_body, v_path, left(nullif(trim(coalesce(p_file_name, '')), ''), 200), now())
  on conflict (homework_id) do update
    set body = excluded.body,
        file_path = coalesce(excluded.file_path, homework_submissions.file_path),
        file_name = case when excluded.file_path is null then homework_submissions.file_name else excluded.file_name end,
        submitted_at = now();
  return json_build_object('ok', true);
end;
$$;

-- 2. Lesson requests -----------------------------------------------------
create table if not exists public.lesson_requests (
  id            bigint generated always as identity primary key,
  assignment_id bigint not null references public.teacher_students (id) on delete cascade,
  teacher_id    text not null references public.teachers (teacher_id) on delete cascade on update cascade,
  student_id    bigint not null references public.students (student_id) on delete cascade,
  subject       text not null,
  starts_at     timestamptz not null,
  duration_min  smallint not null default 90 check (duration_min between 15 and 240),
  makeup_for    bigint references public.lessons (id) on delete set null,
  message       text check (char_length(message) <= 500),
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  reply         text check (char_length(reply) <= 500),
  lesson_id     bigint references public.lessons (id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index if not exists lesson_requests_teacher_idx on public.lesson_requests (teacher_id, status);
create index if not exists lesson_requests_student_idx on public.lesson_requests (student_id, created_at desc);
alter table public.lesson_requests enable row level security;
revoke all on public.lesson_requests from anon, authenticated;
grant select, update, delete on public.lesson_requests to anon, authenticated;
drop policy if exists "Admins manage lesson requests" on public.lesson_requests;
create policy "Admins manage lesson requests" on public.lesson_requests
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.student_request_lesson(p_assignment_id bigint, p_starts_at timestamptz,
                                                          p_makeup_for bigint, p_message text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
  v_a public.teacher_students%rowtype;
  v_rule record;
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  select * into v_a from public.teacher_students where id = p_assignment_id and student_id = v_me;
  if not found then return json_build_object('error', 'Choose one of your classes.'); end if;
  if p_starts_at is null or p_starts_at < now() + interval '12 hours' then
    return json_build_object('error', 'Ask for a time at least 12 hours from now.');
  end if;
  if p_starts_at > now() + interval '120 days' then
    return json_build_object('error', 'Ask for a time within the next 4 months.');
  end if;
  if char_length(coalesce(p_message, '')) > 500 then
    return json_build_object('error', 'The message must be 500 characters or fewer.');
  end if;
  if (select count(*) from public.lesson_requests where student_id = v_me and status = 'pending') >= 5 then
    return json_build_object('error', 'You already have 5 requests waiting. Please wait for your teacher to answer.');
  end if;
  if p_makeup_for is not null then
    select r.rule, r.rescheduled into v_rule
      from public.lesson_rules(array[v_me]) r
      join public.lessons l on l.id = r.lesson_id
     where r.lesson_id = p_makeup_for and l.teacher_id = v_a.teacher_id and l.subject = v_a.subject;
    if not found or v_rule.rule not in ('may', 'courtesy', 'review') or v_rule.rescheduled then
      return json_build_object('error', 'This absence can''t be rescheduled under the attendance policy.');
    end if;
    if exists (select 1 from public.lesson_requests where makeup_for = p_makeup_for and status = 'pending') then
      return json_build_object('error', 'You have already asked for a make-up lesson for this absence.');
    end if;
  end if;
  insert into public.lesson_requests (assignment_id, teacher_id, student_id, subject, starts_at, makeup_for, message)
  values (v_a.id, v_a.teacher_id, v_me, v_a.subject, p_starts_at, p_makeup_for, nullif(trim(coalesce(p_message, '')), ''));
  return json_build_object('ok', true);
end;
$$;

create or replace function public.student_withdraw_request(p_request_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  update public.lesson_requests set status = 'withdrawn', decided_at = now()
   where id = p_request_id and student_id = v_me and status = 'pending';
  if not found then return json_build_object('error', 'This request has already been answered.'); end if;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.student_requests()
returns table (id bigint, subject text, teacher_name text, starts_at timestamptz, duration_min smallint,
               makeup_for bigint, message text, status text, reply text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select r.id, r.subject, t.teacher_name, r.starts_at, r.duration_min, r.makeup_for, r.message, r.status, r.reply, r.created_at
      from public.lesson_requests r
      join public.teachers t on t.teacher_id = r.teacher_id
     where r.student_id = v_me and (r.status = 'pending' or r.created_at > now() - interval '30 days')
     order by (r.status = 'pending') desc, r.created_at desc;
end;
$$;

create or replace function public.teacher_requests()
returns table (id bigint, student_id bigint, student_name text, subject text, starts_at timestamptz,
               duration_min smallint, makeup_for bigint, makeup_starts_at timestamptz, message text,
               status text, reply text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me text := public.current_teacher_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select r.id, r.student_id, s.student_name, r.subject, r.starts_at, r.duration_min, r.makeup_for, m.starts_at,
           r.message, r.status, r.reply, r.created_at
      from public.lesson_requests r
      join public.students s on s.student_id = r.student_id
      left join public.lessons m on m.id = r.makeup_for
     where r.teacher_id = v_me and r.status = 'pending'
     order by r.starts_at;
end;
$$;

-- Accept (books the lesson, checking for clashes) or decline with an optional reply.
create or replace function public.teacher_decide_request(p_request_id bigint, p_accept boolean, p_reply text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_teacher_id();
  v_r public.lesson_requests%rowtype;
  v_res json;
  v_lesson bigint;
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  if char_length(coalesce(p_reply, '')) > 500 then
    return json_build_object('error', 'The reply must be 500 characters or fewer.');
  end if;
  select * into v_r from public.lesson_requests where id = p_request_id and teacher_id = v_me for update;
  if not found then return json_build_object('error', 'Request not found.'); end if;
  if v_r.status <> 'pending' then return json_build_object('error', 'This request has already been answered.'); end if;

  if p_accept then
    if v_r.starts_at < now() then
      return json_build_object('error', 'This time has already passed. Decline it and ask the student for another time.');
    end if;
    v_res := public.teacher_add_lessons(v_r.assignment_id, array[v_r.starts_at], v_r.duration_min, v_r.makeup_for);
    if v_res ->> 'error' is not null then return v_res; end if;
    select id into v_lesson from public.lessons
     where teacher_id = v_me and student_id = v_r.student_id and starts_at = v_r.starts_at and status = 'scheduled'
     order by id desc limit 1;
    update public.lesson_requests
       set status = 'accepted', reply = nullif(trim(coalesce(p_reply, '')), ''), decided_at = now(), lesson_id = v_lesson
     where id = p_request_id;
  else
    update public.lesson_requests
       set status = 'declined', reply = nullif(trim(coalesce(p_reply, '')), ''), decided_at = now()
     where id = p_request_id;
  end if;
  return json_build_object('ok', true);
end;
$$;

-- 3. Private messages (student ↔ teacher) --------------------------------
create table if not exists public.direct_messages (
  id         bigint generated always as identity primary key,
  teacher_id text not null references public.teachers (teacher_id) on delete cascade on update cascade,
  student_id bigint not null references public.students (student_id) on delete cascade,
  sender     text not null check (sender in ('teacher', 'student')),
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists direct_messages_pair_idx on public.direct_messages (teacher_id, student_id, id);
alter table public.direct_messages enable row level security;
revoke all on public.direct_messages from anon, authenticated;
grant select on public.direct_messages to anon, authenticated;
drop policy if exists "Admins read direct messages" on public.direct_messages;
create policy "Admins read direct messages" on public.direct_messages
  for select to anon, authenticated using (public.is_admin());

-- Conversations: one per teacher–student pair that share a class.
create or replace function public.student_dm_threads()
returns table (teacher_id text, teacher_name text, subjects text, unread int, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select t.teacher_id, t.teacher_name, string_agg(distinct a.subject, ', '),
           (select count(*)::int from public.direct_messages m
             where m.teacher_id = t.teacher_id and m.student_id = v_me and m.sender = 'teacher' and m.read_at is null),
           (select max(m.created_at) from public.direct_messages m where m.teacher_id = t.teacher_id and m.student_id = v_me)
      from public.teacher_students a
      join public.teachers t on t.teacher_id = a.teacher_id and t.active
     where a.student_id = v_me
     group by t.teacher_id, t.teacher_name
     order by t.teacher_name;
end;
$$;

create or replace function public.teacher_dm_threads()
returns table (student_id bigint, student_name text, subjects text, unread int, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me text := public.current_teacher_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select s.student_id, s.student_name, string_agg(distinct a.subject, ', '),
           (select count(*)::int from public.direct_messages m
             where m.teacher_id = v_me and m.student_id = s.student_id and m.sender = 'student' and m.read_at is null),
           (select max(m.created_at) from public.direct_messages m where m.teacher_id = v_me and m.student_id = s.student_id)
      from public.teacher_students a
      join public.students s on s.student_id = a.student_id and s.active
     where a.teacher_id = v_me
     group by s.student_id, s.student_name
     order by s.student_name;
end;
$$;

-- Read a conversation (marks the other person's messages as read).
create or replace function public.dm_list(p_other text, p_after_id bigint default 0)
returns table (id bigint, sender text, body text, created_at timestamptz, mine boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_student bigint := public.current_student_id();
  v_teacher text := public.current_teacher_id();
  v_t text; v_s bigint; v_me text;
begin
  if v_student is not null then
    v_t := p_other; v_s := v_student; v_me := 'student';
  elsif v_teacher is not null then
    if coalesce(p_other, '') !~ '^\d{1,12}$' then raise exception 'Conversation not found.'; end if;
    v_t := v_teacher; v_s := p_other::bigint; v_me := 'teacher';
  else
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.teacher_students where teacher_id = v_t and student_id = v_s) then
    raise exception 'Conversation not found.';
  end if;
  update public.direct_messages set read_at = now()
   where teacher_id = v_t and student_id = v_s and sender <> v_me and read_at is null;
  return query
    select m.id, m.sender, m.body, m.created_at, (m.sender = v_me)
      from (select * from public.direct_messages d
             where d.teacher_id = v_t and d.student_id = v_s and d.id > coalesce(p_after_id, 0)
             order by d.id desc limit 200) m
     order by m.id;
end;
$$;

create or replace function public.dm_send(p_other text, p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student bigint := public.current_student_id();
  v_teacher text := public.current_teacher_id();
  v_body text := trim(coalesce(p_body, ''));
  v_t text; v_s bigint; v_me text;
begin
  if v_student is not null then
    if (select must_change_password from public.students where student_id = v_student) then
      return json_build_object('error', 'Please choose a new password first.');
    end if;
    v_t := p_other; v_s := v_student; v_me := 'student';
  elsif v_teacher is not null then
    if coalesce(p_other, '') !~ '^\d{1,12}$' then return json_build_object('error', 'Conversation not found.'); end if;
    v_t := v_teacher; v_s := p_other::bigint; v_me := 'teacher';
  else
    return json_build_object('error', 'Please sign in again.');
  end if;
  if not exists (select 1 from public.teacher_students where teacher_id = v_t and student_id = v_s) then
    return json_build_object('error', 'Conversation not found.');
  end if;
  if char_length(v_body) = 0 or char_length(v_body) > 2000 then
    return json_build_object('error', 'Messages must be 1 to 2000 characters.');
  end if;
  if (select count(*) from public.direct_messages
       where teacher_id = v_t and student_id = v_s and sender = v_me and created_at > now() - interval '1 minute') >= 10 then
    return json_build_object('error', 'You are sending messages too quickly. Please wait a moment.');
  end if;
  insert into public.direct_messages (teacher_id, student_id, sender, body) values (v_t, v_s, v_me, v_body);
  return json_build_object('ok', true);
end;
$$;

-- 4. Attendance history and notes ----------------------------------------
create or replace function public.student_month_lessons(p_month date)
returns table (id bigint, subject text, teacher_name text, starts_at timestamptz, duration_min smallint,
               status text, makeup_for bigint, teacher_note text, absence_reason text, rule text, rescheduled boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select l.id, l.subject, t.teacher_name, l.starts_at, l.duration_min, l.status, l.makeup_for,
           l.teacher_note, l.absence_reason, r.rule, coalesce(r.rescheduled, false)
      from public.lessons l
      join public.teachers t on t.teacher_id = l.teacher_id
      left join public.lesson_rules(array[v_me]) r on r.lesson_id = l.id
     where l.student_id = v_me and public.mm_month(l.starts_at) = date_trunc('month', p_month)::date
     order by l.starts_at;
end;
$$;

-- Absences that may still be rescheduled (for the "Request a make-up lesson" choice).
create or replace function public.student_makeup_options()
returns table (lesson_id bigint, assignment_id bigint, subject text, starts_at timestamptz, rule text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select l.id, a.id, l.subject, l.starts_at, r.rule
      from public.lesson_rules(array[v_me]) r
      join public.lessons l on l.id = r.lesson_id
      join public.teacher_students a on a.teacher_id = l.teacher_id and a.student_id = l.student_id and a.subject = l.subject
     where r.rule in ('may', 'courtesy', 'review') and not r.rescheduled
       and l.starts_at > now() - interval '60 days'
       and not exists (select 1 from public.lesson_requests q where q.makeup_for = l.id and q.status = 'pending')
     order by l.starts_at;
end;
$$;

create or replace function public.student_notes()
returns table (id bigint, subject text, teacher_name text, starts_at timestamptz, teacher_note text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select l.id, l.subject, t.teacher_name, l.starts_at, l.teacher_note
      from public.lessons l
      join public.teachers t on t.teacher_id = l.teacher_id
     where l.student_id = v_me and l.teacher_note is not null
     order by l.starts_at desc
     limit 100;
end;
$$;

-- My classes, with the ids the request form needs.
create or replace function public.student_classes()
returns table (assignment_id bigint, subject text, teacher_id text, teacher_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return query
    select a.id, a.subject, t.teacher_id, t.teacher_name
      from public.teacher_students a
      join public.teachers t on t.teacher_id = a.teacher_id and t.active
     where a.student_id = v_me
     order by a.subject;
end;
$$;

-- Numbers for the tab badges.
create or replace function public.student_counts()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_me bigint := public.current_student_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return json_build_object(
    'homework_due', (select count(*) from public.homework h
                      where h.student_id = v_me and not exists (select 1 from public.homework_submissions s where s.homework_id = h.id)),
    'unread', (select count(*) from public.direct_messages m
                where m.student_id = v_me and m.sender = 'teacher' and m.read_at is null));
end;
$$;

create or replace function public.teacher_counts()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_me text := public.current_teacher_id();
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  return json_build_object(
    'requests', (select count(*) from public.lesson_requests where teacher_id = v_me and status = 'pending'),
    'to_review', (select count(*) from public.homework_submissions s join public.homework h on h.id = s.homework_id
                   where h.teacher_id = v_me and s.reviewed_at is null),
    'unread', (select count(*) from public.direct_messages m
                where m.teacher_id = v_me and m.sender = 'student' and m.read_at is null));
end;
$$;

-- Function permissions
do $$
declare f text;
begin
  foreach f in array array[
    'teacher_add_homework(bigint, text, text, timestamptz)', 'teacher_delete_homework(bigint)', 'teacher_homework()',
    'teacher_review_homework(bigint, text)', 'student_homework()', 'student_submit_homework(bigint, text, text, text)',
    'student_request_lesson(bigint, timestamptz, bigint, text)', 'student_withdraw_request(bigint)', 'student_requests()',
    'teacher_requests()', 'teacher_decide_request(bigint, boolean, text)',
    'student_dm_threads()', 'teacher_dm_threads()', 'dm_list(text, bigint)', 'dm_send(text, text)',
    'student_month_lessons(date)', 'student_makeup_options()', 'student_classes()', 'student_notes()', 'student_counts()', 'teacher_counts()']
  loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end;
$$;
