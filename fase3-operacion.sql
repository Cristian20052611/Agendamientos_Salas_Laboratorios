-- FASE 3 · Operación diaria: check-in/out, liberación por inasistencia, suspensión, extensión, recurrentes, cambio de salón.
-- (RF16, 17, 23, 31, 35, 36, 37). Ejecutar DESPUÉS de fase2b-correcciones.sql. Aditivo: no borra datos.
alter table public.bookings add column if not exists checkin_at timestamptz;
alter table public.bookings add column if not exists checkout_at timestamptz;
alter table public.bookings add column if not exists novedad text;
alter table public.bookings add column if not exists serie_id uuid;
alter table public.bookings add column if not exists contada boolean not null default false;
alter table public.profiles add column if not exists suspendido_hasta timestamptz;

-- Reporte de daño mínimo (lo abre el check-out con novedad; la Fase 4 agrega seguimiento y bloqueos)
create table if not exists public.reportes_dano (
  id bigserial primary key, room text not null, booking_id bigint, tipo text not null default 'Novedad de entrega',
  descripcion text, estado text not null default 'Reportado' check (estado in ('Reportado','En revisión','En reparación','Resuelto')),
  responsable text, reportado_por uuid, created_at timestamptz not null default now());
alter table public.reportes_dano enable row level security;
drop policy if exists dano_leer on public.reportes_dano;
create policy dano_leer on public.reportes_dano for select using (reportado_por = auth.uid() or public.current_rol() in ('coordinador','administrador','mantenimiento'));

create or replace function public.slots_de(p_room text) returns text[] language sql stable security definer set search_path = public as $$
  select case when (select tipo from public.salones where code = p_room) = 'lab'
    then array['18:00-19:00','19:00-20:00','20:00-21:00','21:00-22:00']
    else array['12:00-13:00','13:00-14:00','14:00-15:00','15:00-16:00','16:00-17:00','17:00-18:00'] end $$;

-- check_rules actualizada: bloquea usuarios suspendidos y permite reservar la hora liberada por una inasistencia (RF17/RF37)
create or replace function public.check_rules(p_room text, p_date date, p_slot text, p_uid uuid, p_asist int, p_excl bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.salones; ahora timestamp := now() at time zone 'America/Bogota'; v_rol text; mx_d int; mx_a int; h int;
begin
  select * into s from public.salones where code = p_room;
  if not found then raise exception 'El espacio no existe.'; end if;
  if exists (select 1 from public.profiles where id = p_uid and suspendido_hasta > now()) then
    raise exception 'Estás suspendido para reservar por inasistencias reiteradas hasta %.', (select to_char(suspendido_hasta at time zone 'America/Bogota','DD/MM/YYYY HH24:MI') from public.profiles where id = p_uid); end if;
  if not (p_slot = any (case when s.tipo = 'lab' then array['18:00-19:00','19:00-20:00','20:00-21:00','21:00-22:00']
       else array['12:00-13:00','13:00-14:00','14:00-15:00','15:00-16:00','16:00-17:00','17:00-18:00'] end)) then
    raise exception 'Ese horario no está habilitado para este espacio (bloques de 1 hora).'; end if;
  if p_date is null or p_date < ahora::date or p_date > ahora::date + public.regla('dias_ventana') then
    raise exception 'Solo puedes reservar dentro de los próximos % días.', public.regla('dias_ventana'); end if;
  h := split_part(p_slot, ':', 1)::int;
  if p_date = ahora::date and h <= extract(hour from ahora)::int
     and not exists (select 1 from public.bookings where room = p_room and date = p_date and slot = p_slot and estado = 'no_asistio') then
    raise exception 'Esa hora ya pasó.'; end if;
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

-- RF16 check-in en los primeros 15 minutos
create or replace function public.checkin_booking(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings; ini timestamp; ahora timestamp := now() at time zone 'America/Bogota';
begin
  select * into b from public.bookings where id = p_id for update;
  if not found or (b.user_id is distinct from auth.uid() and coalesce(public.current_rol(),'') not in ('coordinador','administrador')) then raise exception 'No tienes permiso sobre esta reserva.'; end if;
  if b.estado <> 'confirmada' then raise exception 'Solo las reservas confirmadas tienen check-in.'; end if;
  if b.checkin_at is not null then raise exception 'Ya registraste el check-in.'; end if;
  ini := b.date + (split_part(b.slot, ':', 1) || ':00')::time;
  if ahora < ini or ahora > ini + interval '15 minutes' then
    raise exception 'El check-in solo se permite entre las % y las % (primeros 15 minutos).', to_char(ini,'HH24:MI'), to_char(ini + interval '15 minutes','HH24:MI'); end if;
  update public.bookings set checkin_at = now() where id = p_id;
end $$;

-- RF17 + RF37 + RF36: idempotente; la app la llama al abrir y puede programarse con pg_cron
create or replace function public.release_no_shows() returns void language plpgsql security definer set search_path = public as $$
declare ahora timestamp := now() at time zone 'America/Bogota';
begin
  update public.bookings set estado = 'no_asistio'
   where estado = 'confirmada' and checkin_at is null and (date + (split_part(slot, ':', 1) || ':00')::time + interval '15 minutes') < ahora;
  update public.bookings set estado = 'finalizada_sin_registro'
   where estado = 'confirmada' and checkin_at is not null and checkout_at is null and (date + (split_part(slot, ':', 1) || ':00')::time + interval '1 hour') < ahora;
  update public.profiles p set suspendido_hasta = now() + interval '7 days'
   where (p.suspendido_hasta is null or p.suspendido_hasta <= now())
     and exists (select 1 from public.bookings b where b.user_id = p.id and b.estado = 'no_asistio' and not b.contada)
     and (select count(*) from public.bookings b where b.user_id = p.id and b.estado = 'no_asistio' and b.date >= ahora::date - 30) >= 3;
  update public.bookings set contada = true where estado = 'no_asistio' and not contada;
end $$;
-- Opcional (si tu proyecto tiene pg_cron): select cron.schedule('liberar-inasistencias', '* * * * *', 'select public.release_no_shows()');

create or replace function public.lift_suspension(p_user uuid, p_motivo text) returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(public.current_rol(),'') not in ('coordinador','administrador') then raise exception 'Solo el coordinador puede levantar suspensiones.'; end if;
  if coalesce(trim(p_motivo),'') = '' then raise exception 'Indica el motivo.'; end if;
  update public.profiles set suspendido_hasta = null where id = p_user;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'levantar_suspension', 'user:' || p_user, jsonb_build_object('motivo', p_motivo));
end $$;

-- RF36 check-out; con novedad abre un reporte de daño (RF21)
create or replace function public.checkout_booking(p_id bigint, p_ok boolean, p_novedad text) returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_id for update;
  if not found or b.user_id is distinct from auth.uid() then raise exception 'Solo el responsable de la reserva registra la entrega.'; end if;
  if b.estado <> 'confirmada' or b.checkin_at is null then raise exception 'Primero debes hacer el check-in.'; end if;
  if not p_ok and coalesce(trim(p_novedad),'') = '' then raise exception 'Describe la novedad.'; end if;
  update public.bookings set estado = 'finalizada', checkout_at = now(), novedad = case when p_ok then null else p_novedad end where id = p_id;
  if not p_ok then
    insert into public.reportes_dano(room, booking_id, descripcion, reportado_por) values (b.room, b.id, p_novedad, auth.uid());
  end if;
end $$;

-- RF35 extender un bloque desde 15 min antes de terminar
create or replace function public.extend_booking(p_id bigint) returns public.bookings language plpgsql security definer set search_path = public as $$
declare b public.bookings; n public.bookings; ahora timestamp := now() at time zone 'America/Bogota'; ini timestamp; h int; nxt text; v_rol text; mx int;
begin
  select * into b from public.bookings where id = p_id for update;
  if not found or b.user_id is distinct from auth.uid() then raise exception 'Solo el responsable puede ampliar la reserva.'; end if;
  if b.estado <> 'confirmada' or b.checkin_at is null then raise exception 'La reserva debe estar en curso (con check-in).'; end if;
  h := split_part(b.slot, ':', 1)::int; ini := b.date + (h || ':00')::time;
  if ahora >= ini + interval '1 hour' then raise exception 'La reserva ya terminó.'; end if;
  if ahora < ini + interval '45 minutes' then raise exception 'Puedes pedir la ampliación desde 15 minutos antes de la hora de finalización.'; end if;
  nxt := lpad((h + 1)::text, 2, '0') || ':00-' || lpad((h + 2)::text, 2, '0') || ':00';
  if not (nxt = any (public.slots_de(b.room))) then raise exception 'No hay un bloque habilitado después de este; entrega el espacio a las %:00.', h + 1; end if;
  if exists (select 1 from public.bookings where room = b.room and date = b.date and slot = nxt and estado in ('pendiente','confirmada')) then
    raise exception 'El siguiente bloque ya está reservado; debes entregar el espacio a las %:00.', h + 1; end if;
  select rol into v_rol from public.profiles where id = b.user_id;
  mx := public.regla(case when v_rol = 'estudiante' then 'max_dia_estudiante' else 'max_dia_docente' end);
  if (select count(*) from public.bookings where user_id = b.user_id and date = b.date and estado in ('pendiente','confirmada')) >= mx then
    raise exception 'Superarías el límite de % bloques por día.', mx; end if;
  insert into public.bookings(date, room, slot, app_user, documento, subject, user_id, asistentes, estado, checkin_at)
  values (b.date, b.room, nxt, b.app_user, b.documento, b.subject, b.user_id, b.asistentes, 'confirmada', now()) returning * into n;
  return n;
exception when unique_violation then raise exception 'El siguiente bloque ya está reservado; debes entregar el espacio a las %:00.', h + 1;
end $$;

-- RF31 reservas semanales (hasta 4 fechas en total, dentro de la ventana); cada fecha se valida sola
create or replace function public.create_series(p_room text, p_first date, p_slot text, p_reps int, p_doc text, p_subject text, p_asistentes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.profiles; serie uuid := gen_random_uuid(); i int; d date; ok jsonb := '[]'; fail jsonb := '[]';
begin
  select * into pr from public.profiles where id = auth.uid() and activo;
  if not found then raise exception 'Debes iniciar sesión con una cuenta activa.'; end if;
  if pr.rol not in ('docente','coordinador','administrador') then raise exception 'Las reservas recurrentes son para docentes y monitores.'; end if;
  if p_reps < 2 or p_reps > 4 then raise exception 'Elige entre 2 y 4 fechas.'; end if;
  for i in 0 .. p_reps - 1 loop
    d := p_first + i * 7;
    begin
      perform public.check_rules(p_room, d, p_slot, pr.id, p_asistentes);
      insert into public.bookings(date, room, slot, app_user, documento, subject, user_id, asistentes, estado, serie_id)
      values (d, p_room, p_slot, pr.nombre, p_doc, p_subject, pr.id, p_asistentes, 'pendiente', serie);
      ok := ok || to_jsonb(d::text);
    exception when others then
      fail := fail || jsonb_build_object('fecha', d::text, 'motivo', case when sqlstate = '23505' then 'Ya existe otra reserva en ese horario.' else sqlerrm end);
    end;
  end loop;
  return jsonb_build_object('serie', serie, 'creadas', ok, 'fallidas', fail);
end $$;

create or replace function public.cancel_series(p_serie uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set estado = 'cancelada' where serie_id = p_serie and user_id = auth.uid() and estado in ('pendiente','confirmada');
end $$;

-- RF23 cambio de salón (reserva o clase fija); si el nuevo espacio no está libre no se hace
create or replace function public.change_room(p_id bigint, p_new_room text, p_motivo text) returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings; s public.salones;
begin
  if coalesce(public.current_rol(),'') not in ('coordinador','administrador') then raise exception 'Solo el coordinador puede cambiar de salón.'; end if;
  if coalesce(trim(p_motivo),'') = '' then raise exception 'Indica el motivo del cambio.'; end if;
  select * into b from public.bookings where id = p_id for update;
  if not found or b.estado not in ('pendiente','confirmada') then raise exception 'La reserva no está activa.'; end if;
  select * into s from public.salones where code = p_new_room;
  if not found then raise exception 'El nuevo espacio no existe.'; end if;
  if not (b.slot = any (public.slots_de(p_new_room))) then raise exception 'Ese horario no está habilitado en el nuevo espacio.'; end if;
  if s.sillas is not null and s.sillas > 0 and b.asistentes > s.sillas then raise exception 'El nuevo espacio no tiene aforo suficiente (% personas).', s.sillas; end if;
  if exists (select 1 from public.bookings where room = p_new_room and date = b.date and slot = b.slot and estado in ('pendiente','confirmada')) then
    raise exception 'El nuevo espacio no está libre en ese horario; no se realizó el cambio.'; end if;
  update public.bookings set room = p_new_room where id = p_id;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'cambio_salon', 'booking:' || p_id, jsonb_build_object('de', b.room, 'a', p_new_room, 'motivo', p_motivo));
exception when unique_violation then raise exception 'El nuevo espacio no está libre en ese horario; no se realizó el cambio.';
end $$;

create or replace function public.change_class_room(p_class bigint, p_new_room text, p_motivo text) returns void language plpgsql security definer set search_path = public as $$
declare c public.horario_fijo;
begin
  if coalesce(public.current_rol(),'') not in ('coordinador','administrador') then raise exception 'Solo el coordinador puede cambiar de salón.'; end if;
  if coalesce(trim(p_motivo),'') = '' then raise exception 'Indica el motivo del cambio.'; end if;
  select * into c from public.horario_fijo where id = p_class;
  if not found then raise exception 'La clase no existe.'; end if;
  if not exists (select 1 from public.salones where code = p_new_room) then raise exception 'El nuevo espacio no existe.'; end if;
  if exists (select 1 from public.horario_fijo where code = p_new_room and block = c.block) then raise exception 'El nuevo espacio ya tiene clase en ese bloque; no se realizó el cambio.'; end if;
  update public.horario_fijo set code = p_new_room where id = p_class;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'cambio_salon_clase', 'clase:' || p_class, jsonb_build_object('de', c.code, 'a', p_new_room, 'motivo', p_motivo));
end $$;

grant execute on function public.checkin_booking(bigint), public.release_no_shows(), public.lift_suspension(uuid,text),
  public.checkout_booking(bigint,boolean,text), public.extend_booking(bigint), public.create_series(text,date,text,int,text,text,int),
  public.cancel_series(uuid), public.change_room(bigint,text,text), public.change_class_room(bigint,text,text) to authenticated;
