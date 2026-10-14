-- FASE 2 · Reservas sólidas + gestión de usuarios (RF08-15, RF30, RF32). Ejecutar DESPUÉS de fase1-auth.sql.
alter table public.bookings add column if not exists motivo_rechazo text;
alter table public.bookings add column if not exists asistentes int;
-- RF09: la BD garantiza una sola reserva activa por espacio/fecha/hora
create unique index if not exists bookings_slot_unico on public.bookings(date, room, slot) where estado in ('pendiente','confirmada');

create table if not exists public.reglas (clave text primary key, valor int not null);
insert into public.reglas values ('dias_ventana',30),('max_dia_estudiante',2),('max_activas_estudiante',3),('max_dia_docente',4),('max_activas_docente',10) on conflict do nothing;
create table if not exists public.auditoria (id bigserial primary key, actor uuid, accion text, objetivo text, detalle jsonb, created_at timestamptz not null default now());
alter table public.reglas enable row level security;
alter table public.auditoria enable row level security;
drop policy if exists reglas_leer on public.reglas;
create policy reglas_leer on public.reglas for select to authenticated using (true);
drop policy if exists reglas_editar on public.reglas;
create policy reglas_editar on public.reglas for update using (public.current_rol() in ('coordinador','administrador')) with check (public.current_rol() in ('coordinador','administrador'));
drop policy if exists auditoria_leer on public.auditoria;
create policy auditoria_leer on public.auditoria for select using (public.current_rol() in ('coordinador','administrador'));

-- Seguridad de bookings: se reemplazan las políticas abiertas; escribir solo vía funciones.
alter table public.bookings enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='bookings' loop
    execute format('drop policy %I on public.bookings', r.policyname);
  end loop; end $$;
create policy bookings_leer on public.bookings for select to authenticated using (true);
drop policy if exists "admin edita perfiles" on public.profiles;  -- ahora se edita por funciones

create or replace function public.check_rules(p_room text, p_date date, p_slot text, p_uid uuid, p_asist int, p_excl bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.salones; ahora timestamp := now() at time zone 'America/Bogota'; v_rol text; mx_d int; mx_a int; h int;
begin
  select * into s from public.salones where code = p_room;
  if not found then raise exception 'El espacio no existe.'; end if;
  if not (p_slot = any (case when s.tipo = 'lab' then array['18:00-19:00','19:00-20:00','20:00-21:00','21:00-22:00']
       else array['12:00-13:00','13:00-14:00','14:00-15:00','15:00-16:00','16:00-17:00','17:00-18:00'] end)) then
    raise exception 'Ese horario no está habilitado para este espacio (bloques de 1 hora).'; end if;
  if p_date is null or p_date < ahora::date or p_date > ahora::date + public.regla('dias_ventana') then
    raise exception 'Solo puedes reservar dentro de los próximos % días.', public.regla('dias_ventana'); end if;
  h := split_part(p_slot, ':', 1)::int;
  if p_date = ahora::date and h <= extract(hour from ahora)::int then raise exception 'Esa hora ya pasó.'; end if;
  if p_asist is null or p_asist < 1 then raise exception 'Indica la cantidad de asistentes.'; end if;
  if s.sillas is not null and s.sillas > 0 and p_asist > s.sillas then
    raise exception 'Los % asistentes superan el aforo del espacio (% personas).', p_asist, s.sillas; end if;
  select rol into v_rol from public.profiles where id = p_uid;
  mx_d := public.regla(case when v_rol = 'estudiante' then 'max_dia_estudiante' else 'max_dia_docente' end);
  mx_a := public.regla(case when v_rol = 'estudiante' then 'max_activas_estudiante' else 'max_activas_docente' end);
  if (select count(*) from public.bookings where user_id = p_uid and date = p_date and estado in ('pendiente','confirmada') and id is distinct from p_excl) >= mx_d then
    raise exception 'Superaste el límite de % bloques por día.', mx_d; end if;
  if (select count(*) from public.bookings where user_id = p_uid and date >= ahora::date and estado in ('pendiente','confirmada') and id is distinct from p_excl) >= mx_a then
    raise exception 'Superaste el límite de % reservas activas. Cancela alguna para liberar cupo.', mx_a; end if;
  if exists (select 1 from public.bookings where room = p_room and date = p_date and slot = p_slot and estado in ('pendiente','confirmada') and id is distinct from p_excl) then
    raise exception 'Ese horario ya fue reservado por otra persona.'; end if;
end $$;
create or replace function public.regla(k text) returns int language sql stable security definer set search_path = public as $$ select valor from public.reglas where clave = k $$;

create or replace function public.create_booking(p_room text, p_date date, p_slot text, p_doc text, p_subject text, p_asistentes int)
returns public.bookings language plpgsql security definer set search_path = public as $$
declare pr public.profiles; b public.bookings;
begin
  select * into pr from public.profiles where id = auth.uid() and activo;
  if not found then raise exception 'Debes iniciar sesión con una cuenta activa.'; end if;
  perform public.check_rules(p_room, p_date, p_slot, pr.id, p_asistentes);
  insert into public.bookings(date, room, slot, app_user, documento, subject, user_id, asistentes, estado)
  values (p_date, p_room, p_slot, pr.nombre, p_doc, p_subject, pr.id, p_asistentes, 'pendiente') returning * into b;
  return b;
exception when unique_violation then raise exception 'Ese horario ya fue reservado por otra persona.';
end $$;

create or replace function public.cancel_booking(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_id for update;
  if not found then raise exception 'La reserva no existe.'; end if;
  if b.user_id is distinct from auth.uid() and coalesce(public.current_rol(),'') not in ('coordinador','administrador') then
    raise exception 'No tienes permiso para cancelar esta reserva.'; end if;
  if b.estado not in ('pendiente','confirmada') then raise exception 'Esta reserva ya no se puede cancelar.'; end if;
  update public.bookings set estado = 'cancelada' where id = p_id;
end $$;

create or replace function public.modify_booking(p_id bigint, p_date date, p_slot text, p_subject text, p_asistentes int default null)
returns public.bookings language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_id for update;
  if not found or b.user_id is distinct from auth.uid() then raise exception 'Solo quien creó la reserva puede modificarla.'; end if;
  if b.estado not in ('pendiente','confirmada') then raise exception 'Esta reserva ya no se puede modificar.'; end if;
  if (b.date + (split_part(b.slot, ':', 1) || ':00')::time) <= (now() at time zone 'America/Bogota') then
    raise exception 'La reserva ya comenzó; no se puede modificar.'; end if;
  perform public.check_rules(b.room, p_date, p_slot, b.user_id, coalesce(p_asistentes, b.asistentes), p_id);
  update public.bookings set date = p_date, slot = p_slot, subject = p_subject, asistentes = coalesce(p_asistentes, asistentes), estado = 'pendiente'
   where id = p_id returning * into b;
  return b;
exception when unique_violation then raise exception 'Ese horario ya fue reservado por otra persona; se conserva tu reserva original.';
end $$;

create or replace function public.decide_booking(p_id bigint, p_decision text, p_motivo text) returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  if coalesce(public.current_rol(),'') not in ('coordinador','administrador') then raise exception 'Solo el coordinador puede confirmar o rechazar.'; end if;
  select * into b from public.bookings where id = p_id for update;
  if not found or b.estado <> 'pendiente' then raise exception 'La reserva ya no está pendiente.'; end if;
  if p_decision = 'rechazada' and coalesce(trim(p_motivo),'') = '' then raise exception 'Indica el motivo del rechazo.'; end if;
  if p_decision not in ('confirmada','rechazada') then raise exception 'Decisión inválida.'; end if;
  update public.bookings set estado = p_decision, motivo_rechazo = case when p_decision = 'rechazada' then p_motivo end where id = p_id;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), p_decision, 'booking:' || p_id, jsonb_build_object('motivo', p_motivo));
end $$;

create or replace function public.confirm_by_token(p_id bigint, p_token uuid) returns public.bookings language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  update public.bookings set estado = 'confirmada' where id = p_id and confirm_token = p_token and estado = 'pendiente' returning * into b;
  return b;
end $$;

-- RF30: gestión de usuarios (solo administrador)
create or replace function public.admin_set_rol(p_user uuid, p_rol text) returns void language plpgsql security definer set search_path = public as $$
declare t public.profiles;
begin
  if public.current_rol() is distinct from 'administrador' then raise exception 'Solo el administrador puede hacer esto.'; end if;
  select * into t from public.profiles where id = p_user;
  if t.rol = 'administrador' and p_rol <> 'administrador' and not exists (select 1 from public.profiles where rol = 'administrador' and activo and id <> p_user) then
    raise exception 'No puedes quitar el rol al último administrador activo.'; end if;
  update public.profiles set rol = p_rol where id = p_user;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'cambio_rol', 'user:' || p_user, jsonb_build_object('de', t.rol, 'a', p_rol));
end $$;

create or replace function public.admin_set_active(p_user uuid, p_activo boolean) returns void language plpgsql security definer set search_path = public as $$
declare t public.profiles;
begin
  if public.current_rol() is distinct from 'administrador' then raise exception 'Solo el administrador puede hacer esto.'; end if;
  select * into t from public.profiles where id = p_user;
  if t.rol = 'administrador' and not p_activo and not exists (select 1 from public.profiles where rol = 'administrador' and activo and id <> p_user) then
    raise exception 'No puedes desactivar al último administrador activo.'; end if;
  update public.profiles set activo = p_activo where id = p_user;
  if not p_activo then  -- conserva histórico; cancela reservas futuras y libera los espacios
    update public.bookings set estado = 'cancelada' where user_id = p_user and estado in ('pendiente','confirmada') and date >= (now() at time zone 'America/Bogota')::date;
  end if;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), case when p_activo then 'activar' else 'desactivar' end, 'user:' || p_user, '{}'::jsonb);
end $$;

revoke execute on function public.check_rules(text,date,text,uuid,int,bigint) from public, anon, authenticated;
grant execute on function public.create_booking(text,date,text,text,text,int), public.cancel_booking(bigint),
  public.modify_booking(bigint,date,text,text,int), public.decide_booking(bigint,text,text),
  public.admin_set_rol(uuid,text), public.admin_set_active(uuid,boolean) to authenticated;
grant execute on function public.confirm_by_token(bigint,uuid) to anon, authenticated;
