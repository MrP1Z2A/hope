-- =========================================================
-- Hope Education — update 006: lessons, attendance and absences
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER 005_teachers.sql. Safe to run again.
--
-- What it does (rules from the Attendance policy on policies.html):
--   1. Teachers schedule lessons (90 minutes by default) for the students assigned to
--      them, and can repeat a lesson weekly. Double-booking a teacher or student is refused.
--   2. Teachers mark each lesson: attended, late, absent (approved / unapproved /
--      emergency) or cancelled, and can leave a note or homework the student sees.
--   3. Students report an absence in their portal (this is the Absence Form):
--        24 hours or more before the lesson  → approved absence
--        less than 24 hours, emergency       → emergency (reviewed case by case)
--        less than 24 hours, no emergency    → unapproved absence
--      The teacher can change it afterwards.
--   4. Rescheduling rules per student per calendar month (Myanmar time):
--        1st–2nd approved absence  → may be rescheduled
--        3rd+ approved absence     → not required to be rescheduled
--        1st unapproved absence    → may be rescheduled once, as a courtesy
--        2nd+ unapproved absence   → not rescheduled; lesson counted as used
--        emergency                 → reviewed case by case
--      A make-up lesson is linked to the absence it replaces and does not remove it.
--   5. Monthly attendance rate = lessons attended (on time or late) ÷ lessons marked,
--      not counting cancelled lessons or make-up lessons. Admins see warnings:
--        below 75%                                   → attendance warning
--        below 80% the month after a warning         → may inform parent
--        below 50% for two months in a row           → review the service
-- =========================================================

-- 1. Lessons ------------------------------------------------------------
create table if not exists public.lessons (
  id                  bigint generated always as identity primary key,
  teacher_id          text not null references public.teachers (teacher_id) on delete cascade on update cascade,
  student_id          bigint not null references public.students (student_id) on delete cascade,
  subject             text not null check (char_length(subject) between 1 and 100),
  starts_at           timestamptz not null,
  duration_min        smallint not null default 90 check (duration_min between 15 and 240),
  status              text not null default 'scheduled'
                      check (status in ('scheduled', 'attended', 'late', 'absent_approved',
                                        'absent_unapproved', 'absent_emergency', 'cancelled')),
  makeup_for          bigint references public.lessons (id) on delete set null,
  teacher_note        text check (char_length(teacher_note) <= 2000),
  absence_reason      text check (char_length(absence_reason) <= 500),
  absence_reported_at timestamptz,
  marked_at           timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists lessons_teacher_idx on public.lessons (teacher_id, starts_at);
create index if not exists lessons_student_idx on public.lessons (student_id, starts_at);
alter table public.lessons enable row level security;
revoke all on public.lessons from anon, authenticated;

-- Admins can see and correct everything; teachers and students go through the functions below.
grant select, insert, update, delete on public.lessons to anon, authenticated;
drop policy if exists "Admins manage lessons" on public.lessons;
create policy "Admins manage lessons" on public.lessons
  for all to anon, authenticated using (public.is_admin()) with check (public.is_admin());

-- Month of a moment, in Myanmar time.
create or replace function public.mm_month(p_at timestamptz)
returns date
language sql
immutable
as $$ select date_trunc('month', p_at at time zone 'Asia/Yangon')::date; $$;

-- 2. Rescheduling rule for each absence ----------------------------------
-- may / not_required / courtesy / used / review  (see the table at the top)
create or replace function public.lesson_rules(p_student_ids bigint[])
returns table (lesson_id bigint, rule text, rescheduled boolean)
language sql
stable
security definer
set search_path = public
as $$
  with absences as (
    select l.id, l.status,
           row_number() over (partition by l.student_id, public.mm_month(l.starts_at), l.status
                              order by l.starts_at, l.id) as n
      from public.lessons l
     where l.student_id = any (p_student_ids)
       and l.status in ('absent_approved', 'absent_unapproved', 'absent_emergency')
       and l.makeup_for is null
  )
  select a.id,
         case
           when a.status = 'absent_emergency' then 'review'
           when a.status = 'absent_approved'  then case when a.n <= 2 then 'may' else 'not_required' end
           else case when a.n = 1 then 'courtesy' else 'used' end
         end,
         exists (select 1 from public.lessons m where m.makeup_for = a.id and m.status <> 'cancelled')
    from absences a;
$$;
revoke execute on function public.lesson_rules(bigint[]) from public, anon, authenticated;

-- Attendance numbers for some students in one month.
create or replace function public.attendance_numbers(p_student_ids bigint[], p_month date)
returns table (student_id bigint, counted int, attended int, approved int, unapproved int,
               emergency int, upcoming int, rate numeric)
language sql
stable
security definer
set search_path = public
as $$
  select s.sid,
         count(l.id) filter (where l.status not in ('scheduled', 'cancelled'))::int,
         count(l.id) filter (where l.status in ('attended', 'late'))::int,
         count(l.id) filter (where l.status = 'absent_approved')::int,
         count(l.id) filter (where l.status = 'absent_unapproved')::int,
         count(l.id) filter (where l.status = 'absent_emergency')::int,
         count(l.id) filter (where l.status = 'scheduled')::int,
         case when count(l.id) filter (where l.status not in ('scheduled', 'cancelled')) = 0 then null
              else round(100.0 * count(l.id) filter (where l.status in ('attended', 'late'))
                         / count(l.id) filter (where l.status not in ('scheduled', 'cancelled')), 1) end
    from unnest(p_student_ids) as s(sid)
    left join public.lessons l
           on l.student_id = s.sid and l.makeup_for is null
          and public.mm_month(l.starts_at) = date_trunc('month', p_month)::date
   group by s.sid;
$$;
revoke execute on function public.attendance_numbers(bigint[], date) from public, anon, authenticated;

-- 3. Teacher functions ---------------------------------------------------
-- My lessons between two moments (with the student's name, class link and absence rule).
create or replace function public.teacher_lessons(p_from timestamptz, p_to timestamptz)
returns table (id bigint, student_id bigint, student_name text, subject text, starts_at timestamptz,
               duration_min smallint, status text, makeup_for bigint, teacher_note text,
               absence_reason text, absence_reported_at timestamptz, class_link text,
               rule text, rescheduled boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me text := public.current_teacher_id();
  v_ids bigint[];
begin
  if v_me is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  select array_agg(distinct l.student_id) into v_ids from public.lessons l where l.teacher_id = v_me;
  return query
    select l.id, l.student_id, s.student_name, l.subject, l.starts_at, l.duration_min, l.status,
           l.makeup_for, l.teacher_note, l.absence_reason, l.absence_reported_at, a.class_link,
           r.rule, coalesce(r.rescheduled, false)
      from public.lessons l
      join public.students s on s.student_id = l.student_id
      left join public.teacher_students a
             on a.teacher_id = l.teacher_id and a.student_id = l.student_id and a.subject = l.subject
      left join public.lesson_rules(coalesce(v_ids, '{}')) r on r.lesson_id = l.id
     where l.teacher_id = v_me
       and l.starts_at >= p_from and l.starts_at < p_to
     order by l.starts_at;
end;
$$;

-- Add lessons for one of my students: one per start time (e.g. weekly repeats).
-- p_makeup_for: the absence this lesson replaces (optional).
create or replace function public.teacher_add_lessons(p_assignment_id bigint, p_starts timestamptz[],
                                                       p_duration_min int default 90, p_makeup_for bigint default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_teacher_id();
  v_a public.teacher_students%rowtype;
  v_start timestamptz;
  v_end timestamptz;
  v_count int := 0;
begin
  if v_me is null then
    return json_build_object('error', 'Please sign in again.');
  end if;
  select * into v_a from public.teacher_students where id = p_assignment_id and teacher_id = v_me;
  if not found then
    return json_build_object('error', 'This student is not assigned to you.');
  end if;
  if p_starts is null or array_length(p_starts, 1) is null or array_length(p_starts, 1) > 26 then
    return json_build_object('error', 'Add between 1 and 26 lessons at a time.');
  end if;
  if p_duration_min is null or p_duration_min < 15 or p_duration_min > 240 then
    return json_build_object('error', 'Lesson length must be 15 to 240 minutes.');
  end if;
  if p_makeup_for is not null and not exists (
       select 1 from public.lessons
        where id = p_makeup_for and teacher_id = v_me and student_id = v_a.student_id
          and status in ('absent_approved', 'absent_unapproved', 'absent_emergency')) then
    return json_build_object('error', 'The make-up lesson must replace one of this student''s absences.');
  end if;
  if p_makeup_for is not null and array_length(p_starts, 1) <> 1 then
    return json_build_object('error', 'A make-up lesson replaces one absence, so add one lesson only.');
  end if;

  foreach v_start in array p_starts loop
    if v_start < now() - interval '1 day' then
      return json_build_object('error', 'Lessons can''t start in the past.');
    end if;
    v_end := v_start + make_interval(mins => p_duration_min);
    if exists (select 1 from public.lessons l
                where l.status <> 'cancelled'
                  and (l.teacher_id = v_me or l.student_id = v_a.student_id)
                  and l.starts_at < v_end
                  and l.starts_at + make_interval(mins => l.duration_min) > v_start) then
      -- The portal shows clash_at in the teacher's own time.
      return json_build_object('error', 'Another lesson is already booked at this time.', 'clash_at', v_start);
    end if;
  end loop;

  -- All checked: add them (none are added if any start time clashes).
  foreach v_start in array p_starts loop
    insert into public.lessons (teacher_id, student_id, subject, starts_at, duration_min, makeup_for)
    values (v_me, v_a.student_id, v_a.subject, v_start, p_duration_min, p_makeup_for);
    v_count := v_count + 1;
  end loop;
  return json_build_object('ok', true, 'added', v_count);
end;
$$;

-- Mark a lesson and/or save the note. p_status null = keep the status.
create or replace function public.teacher_mark_lesson(p_lesson_id bigint, p_status text, p_note text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_teacher_id();
  v_l public.lessons%rowtype;
  v_status text;
begin
  if v_me is null then
    return json_build_object('error', 'Please sign in again.');
  end if;
  select * into v_l from public.lessons where id = p_lesson_id and teacher_id = v_me for update;
  if not found then
    return json_build_object('error', 'This lesson is not yours.');
  end if;
  v_status := coalesce(p_status, v_l.status);
  if v_status not in ('scheduled', 'attended', 'late', 'absent_approved', 'absent_unapproved', 'absent_emergency', 'cancelled') then
    return json_build_object('error', 'Unknown status.');
  end if;
  if v_status in ('attended', 'late', 'absent_unapproved') and v_l.starts_at > now() then
    return json_build_object('error', 'This lesson hasn''t started yet.');
  end if;
  if char_length(coalesce(p_note, '')) > 2000 then
    return json_build_object('error', 'The note must be 2000 characters or fewer.');
  end if;
  update public.lessons
     set status = v_status,
         teacher_note = nullif(trim(coalesce(p_note, '')), ''),
         marked_at = case when v_status <> v_l.status then now() else marked_at end
   where id = p_lesson_id;
  return json_build_object('ok', true);
end;
$$;

-- Attendance this month for each of my students.
create or replace function public.teacher_attendance(p_month date)
returns table (student_id bigint, student_name text, counted int, attended int, approved int,
               unapproved int, emergency int, upcoming int, rate numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me text := public.current_teacher_id();
  v_ids bigint[];
begin
  if v_me is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  select array_agg(distinct a.student_id) into v_ids from public.teacher_students a where a.teacher_id = v_me;
  return query
    select n.student_id, s.student_name, n.counted, n.attended, n.approved, n.unapproved, n.emergency, n.upcoming, n.rate
      from public.attendance_numbers(coalesce(v_ids, '{}'), p_month) n
      join public.students s on s.student_id = n.student_id
     order by s.student_name;
end;
$$;

-- 4. Student functions ---------------------------------------------------
create or replace function public.student_lessons(p_from timestamptz, p_to timestamptz)
returns table (id bigint, subject text, teacher_name text, starts_at timestamptz, duration_min smallint,
               status text, makeup_for bigint, teacher_note text, absence_reason text, class_link text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_me bigint := public.current_student_id();
begin
  if v_me is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  return query
    select l.id, l.subject, t.teacher_name, l.starts_at, l.duration_min, l.status, l.makeup_for,
           l.teacher_note, l.absence_reason, a.class_link
      from public.lessons l
      join public.teachers t on t.teacher_id = l.teacher_id
      left join public.teacher_students a
             on a.teacher_id = l.teacher_id and a.student_id = l.student_id and a.subject = l.subject
     where l.student_id = v_me
       and l.starts_at >= p_from and l.starts_at < p_to
     order by l.starts_at;
end;
$$;

-- The Absence Form: tell us you can't come to a lesson.
create or replace function public.student_report_absence(p_lesson_id bigint, p_reason text, p_emergency boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
  v_l public.lessons%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
  v_status text;
begin
  if v_me is null then
    return json_build_object('error', 'Please sign in again.');
  end if;
  select * into v_l from public.lessons where id = p_lesson_id and student_id = v_me for update;
  if not found then
    return json_build_object('error', 'Lesson not found.');
  end if;
  if v_l.status <> 'scheduled' then
    return json_build_object('error', 'This lesson has already been marked.');
  end if;
  if v_l.starts_at + make_interval(mins => v_l.duration_min) < now() then
    return json_build_object('error', 'This lesson has already finished.');
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    return json_build_object('error', 'Please write the reason (up to 500 characters).');
  end if;
  v_status := case
    when v_l.starts_at - now() >= interval '24 hours' then 'absent_approved'
    when coalesce(p_emergency, false) then 'absent_emergency'
    else 'absent_unapproved'
  end;
  update public.lessons
     set status = v_status, absence_reason = v_reason, absence_reported_at = now(), marked_at = now()
   where id = p_lesson_id;
  return json_build_object('ok', true, 'status', v_status);
end;
$$;

create or replace function public.student_attendance(p_month date)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
  v_row record;
begin
  if v_me is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  select * into v_row from public.attendance_numbers(array[v_me], p_month);
  return json_build_object('counted', v_row.counted, 'attended', v_row.attended, 'approved', v_row.approved,
                           'unapproved', v_row.unapproved, 'emergency', v_row.emergency, 'rate', v_row.rate);
end;
$$;

-- 5. Admin: attendance for every student, this month and last month -----
create or replace function public.admin_attendance(p_month date)
returns table (student_id bigint, student_name text, package text, scheduled int, counted int, attended int,
               approved int, unapproved int, emergency int, rate numeric, prev_rate numeric, flag text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_ids bigint[];
  v_month date := date_trunc('month', p_month)::date;
begin
  if not public.is_admin() then
    raise exception 'Only admins can see this' using errcode = '42501';
  end if;
  select array_agg(s.student_id) into v_ids from public.students s where s.active;
  return query
    select s.student_id, s.student_name, e.package,
           (select count(*)::int from public.lessons l
             where l.student_id = s.student_id and l.makeup_for is null and l.status <> 'cancelled'
               and public.mm_month(l.starts_at) = v_month),
           cur.counted, cur.attended, cur.approved, cur.unapproved, cur.emergency, cur.rate, prev.rate,
           case
             when cur.rate < 50 and prev.rate < 50 then 'Below 50% two months in a row – review the service'
             when cur.rate < 80 and prev.rate < 75 then 'Still below 80% after a warning – may inform parent'
             when cur.rate < 75 then 'Below 75% – attendance warning'
             else null
           end
      from public.students s
      join public.attendance_numbers(coalesce(v_ids, '{}'), v_month) cur on cur.student_id = s.student_id
      join public.attendance_numbers(coalesce(v_ids, '{}'), (v_month - interval '1 month')::date) prev
        on prev.student_id = s.student_id
      left join lateral (
        select en.package from public.enrolments en
         where en.student_id = s.student_id
         order by (en.status = 'Active') desc, en.created_at desc limit 1
      ) e on true
     where s.active
     order by s.student_name;
end;
$$;

-- Function permissions
revoke execute on function public.teacher_lessons(timestamptz, timestamptz)              from public;
revoke execute on function public.teacher_add_lessons(bigint, timestamptz[], int, bigint) from public;
revoke execute on function public.teacher_mark_lesson(bigint, text, text)                 from public;
revoke execute on function public.teacher_attendance(date)                                from public;
revoke execute on function public.student_lessons(timestamptz, timestamptz)              from public;
revoke execute on function public.student_report_absence(bigint, text, boolean)          from public;
revoke execute on function public.student_attendance(date)                                from public;
revoke execute on function public.admin_attendance(date)                                  from public;
grant execute on function public.teacher_lessons(timestamptz, timestamptz)               to anon, authenticated;
grant execute on function public.teacher_add_lessons(bigint, timestamptz[], int, bigint)  to anon, authenticated;
grant execute on function public.teacher_mark_lesson(bigint, text, text)                  to anon, authenticated;
grant execute on function public.teacher_attendance(date)                                 to anon, authenticated;
grant execute on function public.student_lessons(timestamptz, timestamptz)               to anon, authenticated;
grant execute on function public.student_report_absence(bigint, text, boolean)           to anon, authenticated;
grant execute on function public.student_attendance(date)                                 to anon, authenticated;
grant execute on function public.admin_attendance(date)                                   to anon, authenticated;
