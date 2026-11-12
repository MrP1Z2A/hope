-- =========================================================
-- Hope Education — update 002: QR payment and proof of payment
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER schema.sql. Safe to run again; it does not delete data.
--
-- What it does:
--   1. Adds payment columns to "enrolments".
--   2. Lets the website submit enrolments as "Payment Pending" (receipt attached).
--   3. Creates a PRIVATE storage bucket "payment-receipts" (images or PDF, max 5 MB).
--      Visitors can upload a receipt but can never view, list, replace or delete receipts.
--      Admins view receipts in Dashboard → Storage → payment-receipts.
--   4. activate_enrolment() now also records when the payment was verified.
-- =========================================================

-- 1. Payment columns
alter table public.enrolments
  add column if not exists receipt_path         text check (char_length(receipt_path) <= 500),
  add column if not exists payment_reference    text check (char_length(payment_reference) <= 100),
  add column if not exists payment_submitted_at timestamptz,
  add column if not exists payment_verified_at  timestamptz;

-- 2. Website may submit a new enrolment with or without a receipt, but never as verified/active
drop policy if exists "Website can submit enrolments" on public.enrolments;
create policy "Website can submit enrolments" on public.enrolments
  for insert to anon, authenticated
  with check (
    status in ('New request', 'Payment Pending')
    and student_id is null
    and admin_notes is null
    and payment_verified_at is null
    and policy_agreed
  );

-- 3. Private bucket for receipts
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-receipts', 'payment-receipts', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Upload only. There are no select/update/delete policies for visitors.
drop policy if exists "Website can upload payment receipts" on storage.objects;
create policy "Website can upload payment receipts" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'payment-receipts');

-- 4. Activating an enrolment also records payment verification
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
     set student_id = v_student_id,
         status = 'Active',
         payment_verified_at = coalesce(payment_verified_at, now())
   where id = p_enrolment_id;

  return v_student_id;
end;
$$;

revoke execute on function public.activate_enrolment(bigint) from public, anon, authenticated;
