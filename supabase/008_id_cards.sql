-- =========================================================
-- Hope Education — update 008: student photos and digital ID cards
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER 007_student_features.sql. Safe to run again.
--
-- What it does:
--   1. The enrolment form asks for a photo for the student ID card. Photos are
--      stored privately in the "student-photos" bucket (JPEG, max 2 MB).
--   2. "Accept payment and enrol" now also issues the ID card: it copies the
--      enrolment photo to the student and sets the card dates
--      (valid for 1 year; accepting a later payment extends it).
--   3. Students see and print their card in the student portal. Students who
--      enrolled before this update (no photo yet) can add one once; after that
--      only admins can change it.
--   4. Admins see the photo when checking an enrolment, and can view, print
--      and change any student's card in the Students tab.
-- =========================================================

alter table public.enrolments add column if not exists photo_path text check (char_length(photo_path) <= 300);
alter table public.students  add column if not exists photo_path       text check (char_length(photo_path) <= 300);
alter table public.students  add column if not exists card_issued_at   timestamptz;
alter table public.students  add column if not exists card_valid_until date;

-- Admins can read the card columns and change the photo / validity.
grant select (student_id, email, student_name, created_at, active, must_change_password, last_login_at,
              photo_path, card_issued_at, card_valid_until)
  on public.students to anon, authenticated;
grant update (photo_path, card_issued_at, card_valid_until) on public.students to anon, authenticated;
drop policy if exists "Admins update student cards" on public.students;
create policy "Admins update student cards" on public.students
  for update to anon, authenticated using (public.is_admin()) with check (public.is_admin());

-- 1. Private bucket for ID photos: YYYY-MM/<random>.jpg -------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-photos', 'student-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Anyone filling in the enrolment form can upload a photo (like payment receipts),
-- but can't view, replace or list photos.
drop policy if exists "Anyone uploads an ID photo" on storage.objects;
create policy "Anyone uploads an ID photo" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'student-photos' and name ~ '^\d{4}-\d{2}/[A-Za-z0-9-]+\.jpg$');

-- Is this the signed-in student's own card photo?
create or replace function public.student_owns_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.students
                  where student_id = public.current_student_id() and photo_path = p_name);
$$;
grant execute on function public.student_owns_photo(text) to anon, authenticated;

drop policy if exists "Read ID photos" on storage.objects;
create policy "Read ID photos" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'student-photos' and (public.is_admin() or public.student_owns_photo(name)));

drop policy if exists "Admins manage ID photos" on storage.objects;
create policy "Admins manage ID photos" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'student-photos' and public.is_admin());

-- 2. Accepting a payment issues / renews the ID card ---------------------
create or replace function public.accept_enrolment(p_enrolment_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid bigint;
  v_student public.students%rowtype;
  v_photo text;
  v_temp text;
begin
  if not (public.is_admin() or auth.role() = 'service_role' or session_user = 'postgres') then
    raise exception 'Only admins can accept enrolments' using errcode = '42501';
  end if;

  v_sid := public.activate_enrolment(p_enrolment_id);
  select photo_path into v_photo from public.enrolments where id = p_enrolment_id;
  select * into v_student from public.students where student_id = v_sid for update;

  if v_student.password is null then
    v_temp := public.make_temp_password();
    update public.students set password = v_temp, must_change_password = true where student_id = v_sid;
  end if;

  update public.students
     set photo_path       = coalesce(v_photo, photo_path),
         card_issued_at   = coalesce(card_issued_at, now()),
         card_valid_until = greatest(coalesce(card_valid_until, current_date),
                                     ((now() at time zone 'Asia/Yangon')::date + interval '1 year')::date)
   where student_id = v_sid;

  return json_build_object('student_id', v_sid, 'student_name', v_student.student_name,
                           'email', v_student.email, 'temp_password', v_temp);
end;
$$;
revoke execute on function public.accept_enrolment(bigint) from public;
grant execute on function public.accept_enrolment(bigint) to anon, authenticated;

-- 3. Student: my ID card --------------------------------------------------
create or replace function public.student_card()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
  v_s public.students%rowtype;
  v_subjects text;
begin
  if v_me is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
  select * into v_s from public.students where student_id = v_me;
  select string_agg(distinct a.subject, ', ' order by a.subject) into v_subjects
    from public.teacher_students a where a.student_id = v_me;
  if v_subjects is null then
    select array_to_string(e.subjects, ', ') into v_subjects
      from public.enrolments e where e.student_id = v_me
     order by (e.status = 'Active') desc, e.created_at desc limit 1;
  end if;
  return json_build_object('student_id', v_s.student_id, 'student_name', v_s.student_name,
                           'photo_path', v_s.photo_path, 'card_issued_at', v_s.card_issued_at,
                           'card_valid_until', v_s.card_valid_until, 'subjects', v_subjects);
end;
$$;

-- Add my photo (only if I don't have one yet; after that admins change it).
create or replace function public.student_set_photo(p_path text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me bigint := public.current_student_id();
begin
  if v_me is null then return json_build_object('error', 'Please sign in again.'); end if;
  if (select photo_path from public.students where student_id = v_me) is not null then
    return json_build_object('error', 'You already have a photo. Please ask Hope Education to change it.');
  end if;
  if coalesce(p_path, '') !~ '^\d{4}-\d{2}/[A-Za-z0-9-]+\.jpg$'
     or not exists (select 1 from storage.objects where bucket_id = 'student-photos' and name = p_path)
     or exists (select 1 from public.students where photo_path = p_path)
     or exists (select 1 from public.enrolments where photo_path = p_path) then
    return json_build_object('error', 'The photo could not be found. Please choose it again.');
  end if;
  update public.students
     set photo_path = p_path,
         card_issued_at = coalesce(card_issued_at, now()),
         card_valid_until = coalesce(card_valid_until, ((now() at time zone 'Asia/Yangon')::date + interval '1 year')::date)
   where student_id = v_me;
  return json_build_object('ok', true);
end;
$$;

revoke execute on function public.student_card()          from public;
revoke execute on function public.student_set_photo(text) from public;
grant execute on function public.student_card()           to anon, authenticated;
grant execute on function public.student_set_photo(text)  to anon, authenticated;
