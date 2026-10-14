-- FASE 4 · Espacios: inventario, bloqueos, daños, eventos, alternativas (RF20-22, 33, 34, 38, 39; completa RF05).
-- Ejecutar DESPUÉS de fase3-operacion.sql. Aditivo: no borra datos.
alter table public.salones add column if not exists activo boolean not null default true;
create table if not exists public.recursos (id bigserial primary key, room text not null, tipo text not null,
  cantidad int not null default 1 check (cantidad >= 0), operativos int not null default 1 check (operativos >= 0),
  estado text not null default 'operativo' check (estado in ('operativo','en reparación','baja')), activo boolean not null default true);
create table if not exists public.bloqueos (id bigserial primary key, room text not null, desde timestamp not null, hasta timestamp not null,
  tipo text not null check (tipo in ('daño','mantenimiento','evento')), motivo text, reporte_id bigint, evento_id bigint,
  activo boolean not null default true, creado_por uuid, created_at timestamptz not null default now());
create table if not exists public.eventos (id bigserial primary key, nombre text not null, responsable text, rooms text[] not null,
  desde timestamp not null, hasta timestamp not null, asistentes int, creado_por uuid, created_at timestamptz not null default now());
create table if not exists public.reporte_historial (id bigserial primary key, reporte_id bigint not null, estado text, responsable text, observacion text, actor uuid, created_at timestamptz not null default now());
alter table public.recursos enable row level security; alter table public.bloqueos enable row level security;
alter table public.eventos enable row level security; alter table public.reporte_historial enable row level security;
drop policy if exists recursos_leer on public.recursos; create policy recursos_leer on public.recursos for select using (true);
drop policy if exists bloqueos_leer on public.bloqueos; create policy bloqueos_leer on public.bloqueos for select using (true);
drop policy if exists eventos_leer on public.eventos; create policy eventos_leer on public.eventos for select using (coalesce(public.current_rol(),'') in ('coordinador','administrador'));
drop policy if exists hist_leer on public.reporte_historial; create policy hist_leer on public.reporte_historial for select using (
  coalesce(public.current_rol(),'') in ('coordinador','administrador','mantenimiento') or exists (select 1 from public.reportes_dano d where d.id = reporte_id and d.reportado_por = auth.uid()));

-- Recursos iniciales a partir de los datos que ya tienes en salones (solo si aún no existen)
insert into public.recursos(room, tipo, cantidad, operativos)
select code, 'Computador', (regexp_match(equipo, 'PC:(\d+)'))[1]::int, (regexp_match(equipo, 'PC:(\d+)'))[1]::int from public.salones
 where equipo ~ 'PC:[1-9]' and not exists (select 1 from public.recursos r where r.room = salones.code and r.tipo = 'Computador');
insert into public.recursos(room, tipo, cantidad, operativos)
select code, 'Televisor', (regexp_match(equipo, 'TV:(\d+)'))[1]::int, (regexp_match(equipo, 'TV:(\d+)'))[1]::int from public.salones
 where equipo ~ 'TV:[1-9]' and not exists (select 1 from public.recursos r where r.room = salones.code and r.tipo = 'Televisor');
insert into public.recursos(room, tipo, cantidad, operativos)
select code, 'Video beam', 1, 1 from public.salones where video_beam = 1 and not exists (select 1 from public.recursos r where r.room = salones.code and r.tipo = 'Video beam');

create or replace function public.es_staff() returns boolean language sql stable security definer set search_path = public as $$ select coalesce(public.current_rol(),'') in ('coordinador','administrador') $$;
create or replace function public.can_maint() returns boolean language sql stable security definer set search_path = public as $$ select coalesce(public.current_rol(),'') in ('coordinador','administrador','mantenimiento') $$;

-- Reglas que ahora respetan espacios de baja y bloqueos (reemplazan las versiones anteriores)
create or replace function public.check_rules(p_room text, p_date date, p_slot text, p_uid uuid, p_asist int, p_excl bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.salones; ahora timestamp := now() at time zone 'America/Bogota'; v_rol text; mx_d int; mx_a int; h int;
begin
  select * into s from public.salones where code = p_room;
  if not found then raise exception 'El espacio no existe.'; end if;
  if s.activo is false then raise exception 'Este espacio no está disponible para reservas.'; end if;
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
  if exists (select 1 from public.bloqueos where room = p_room and activo and desde < (p_date + (split_part(p_slot, ':', 1) || ':00')::time + interval '1 hour') and hasta > (p_date + (split_part(p_slot, ':', 1) || ':00')::time)) then
    raise exception 'El espacio está bloqueado en ese horario.'; end if;
  if exists (select 1 from public.bookings where room = p_room and date = p_date and slot = p_slot and estado in ('pendiente','confirmada') and id is distinct from p_excl) then
    raise exception 'Ese horario ya fue reservado por otra persona.'; end if;
end $$;

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
  if exists (select 1 from public.bloqueos where room = b.room and activo and desde < (b.date + (split_part(nxt, ':', 1) || ':00')::time + interval '1 hour') and hasta > (b.date + (split_part(nxt, ':', 1) || ':00')::time)) then
    raise exception 'El siguiente bloque está bloqueado; debes entregar el espacio a las %:00.', h + 1; end if;
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

create or replace function public.change_room(p_id bigint, p_new_room text, p_motivo text) returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings; s public.salones;
begin
  if coalesce(public.current_rol(),'') not in ('coordinador','administrador') then raise exception 'Solo el coordinador puede cambiar de salón.'; end if;
  if coalesce(trim(p_motivo),'') = '' then raise exception 'Indica el motivo del cambio.'; end if;
  select * into b from public.bookings where id = p_id for update;
  if not found or b.estado not in ('pendiente','confirmada') then raise exception 'La reserva no está activa.'; end if;
  select * into s from public.salones where code = p_new_room;
  if not found or s.activo is false then raise exception 'El nuevo espacio no existe o está de baja.'; end if;
  if not (b.slot = any (public.slots_de(p_new_room))) then raise exception 'Ese horario no está habilitado en el nuevo espacio.'; end if;
  if s.sillas is not null and s.sillas > 0 and b.asistentes > s.sillas then raise exception 'El nuevo espacio no tiene aforo suficiente (% personas).', s.sillas; end if;
  if exists (select 1 from public.bloqueos where room = p_new_room and activo and desde < (b.date + (split_part(b.slot, ':', 1) || ':00')::time + interval '1 hour') and hasta > (b.date + (split_part(b.slot, ':', 1) || ':00')::time)) then
    raise exception 'El espacio está bloqueado en ese horario.'; end if;
  if exists (select 1 from public.bookings where room = p_new_room and date = b.date and slot = b.slot and estado in ('pendiente','confirmada')) then
    raise exception 'El nuevo espacio no está libre en ese horario; no se realizó el cambio.'; end if;
  update public.bookings set room = p_new_room where id = p_id;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'cambio_salon', 'booking:' || p_id, jsonb_build_object('de', b.room, 'a', p_new_room, 'motivo', p_motivo));
exception when unique_violation then raise exception 'El nuevo espacio no está libre en ese horario; no se realizó el cambio.';
end $$;

-- RF21: cada reporte (incluido el del check-out) bloquea el espacio hasta que se revise
create or replace function public.trg_reporte() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.bloqueos(room, desde, hasta, tipo, motivo, reporte_id, creado_por)
  values (new.room, now() at time zone 'America/Bogota', '9999-12-31'::timestamp, 'daño', 'Daño reportado: ' || coalesce(new.tipo,''), new.id, new.reportado_por);
  insert into public.reporte_historial(reporte_id, estado, observacion, actor) values (new.id, 'Reportado', new.descripcion, new.reportado_por);
  return new;
end $$;
drop trigger if exists reporte_bloquea on public.reportes_dano;
create trigger reporte_bloquea after insert on public.reportes_dano for each row execute function public.trg_reporte();

create or replace function public.report_damage(p_room text, p_tipo text, p_desc text) returns bigint language plpgsql security definer set search_path = public as $$
declare id bigint;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and activo) then raise exception 'Debes iniciar sesión.'; end if;
  if coalesce(trim(p_desc),'') = '' then raise exception 'Describe la falla.'; end if;
  if not exists (select 1 from public.salones where code = p_room) then raise exception 'El espacio no existe.'; end if;
  insert into public.reportes_dano(room, tipo, descripcion, reportado_por) values (p_room, p_tipo, p_desc, auth.uid()) returning reportes_dano.id into id;
  return id;
end $$;

-- RF38 seguimiento: estado, responsable y observaciones con historial; al resolver se PROPONE desbloquear
create or replace function public.update_report(p_id bigint, p_estado text, p_resp text, p_obs text) returns jsonb language plpgsql security definer set search_path = public as $$
declare bid bigint;
begin
  if not public.can_maint() then raise exception 'No tienes permiso para gestionar reportes.'; end if;
  if p_estado not in ('Reportado','En revisión','En reparación','Resuelto') then raise exception 'Estado inválido.'; end if;
  update public.reportes_dano set estado = p_estado, responsable = nullif(trim(p_resp),'') where id = p_id;
  if not found then raise exception 'El reporte no existe.'; end if;
  insert into public.reporte_historial(reporte_id, estado, responsable, observacion, actor) values (p_id, p_estado, p_resp, p_obs, auth.uid());
  if p_estado = 'Resuelto' then select id into bid from public.bloqueos where reporte_id = p_id and activo limit 1; end if;
  return jsonb_build_object('resuelto', p_estado = 'Resuelto', 'bloqueo_id', bid);
end $$;

create or replace function public.affected_bookings(p_rooms text[], p_desde timestamp, p_hasta timestamp) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'room', room, 'date', date, 'slot', slot, 'usuario', app_user)), '[]') from public.bookings
   where room = any (p_rooms) and estado in ('pendiente','confirmada')
     and (date + (split_part(slot, ':', 1) || ':00')::time) < p_hasta and (date + (split_part(slot, ':', 1) || ':00')::time + interval '1 hour') > p_desde $$;

create or replace function public.create_block(p_room text, p_desde timestamp, p_hasta timestamp, p_tipo text, p_motivo text) returns jsonb language plpgsql security definer set search_path = public as $$
declare id bigint;
begin
  if not public.es_staff() then raise exception 'Solo el coordinador puede bloquear espacios.'; end if;
  if p_hasta <= p_desde then raise exception 'La fecha final debe ser posterior a la inicial.'; end if;
  insert into public.bloqueos(room, desde, hasta, tipo, motivo, creado_por) values (p_room, p_desde, p_hasta, p_tipo, coalesce(nullif(trim(p_motivo),''), initcap(p_tipo)), auth.uid()) returning bloqueos.id into id;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'bloqueo', 'room:' || p_room, jsonb_build_object('tipo', p_tipo, 'motivo', p_motivo));
  return jsonb_build_object('id', id, 'afectadas', public.affected_bookings(array[p_room], p_desde, p_hasta));
end $$;

create or replace function public.unblock(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.es_staff() then raise exception 'Solo el coordinador puede desbloquear espacios.'; end if;
  update public.bloqueos set activo = false where id = p_id;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'desbloqueo', 'bloqueo:' || p_id, '{}'::jsonb);
end $$;

-- RF33 hasta 5 alternativas libres: mismo tipo, aforo suficiente, recursos obligatorios, más cercanas primero
create or replace function public.suggest_alternatives(p_room text, p_date date, p_slot text, p_asist int, p_recursos text[] default '{}') returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
    select s.code, s.label, s.piso, s.sillas from public.salones s, (select tipo, piso from public.salones where code = p_room) o
     where s.activo and s.code <> p_room and s.tipo = o.tipo and p_slot = any (public.slots_de(s.code))
       and (p_asist is null or s.sillas >= p_asist)
       and not exists (select 1 from public.bookings b where b.room = s.code and b.date = p_date and b.slot = p_slot and b.estado in ('pendiente','confirmada'))
       and not exists (select 1 from public.bloqueos k where k.room = s.code and k.activo
            and k.desde < (p_date + (split_part(p_slot, ':', 1) || ':00')::time + interval '1 hour') and k.hasta > (p_date + (split_part(p_slot, ':', 1) || ':00')::time))
       and not exists (select 1 from unnest(coalesce(p_recursos, '{}')) rq where not exists (select 1 from public.recursos r where r.room = s.code and r.activo and r.estado = 'operativo' and r.operativos > 0 and lower(r.tipo) = lower(rq)))
     order by (s.piso = o.piso) desc, abs(s.piso - o.piso), s.code limit 5) x $$;

-- RF39 evento institucional con prioridad: p_confirm=false solo muestra lo afectado
create or replace function public.create_event(p_nombre text, p_resp text, p_rooms text[], p_desde timestamp, p_hasta timestamp, p_asist int, p_confirm boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare ev bigint; aff jsonb; cls jsonb; r text; b record; alts jsonb := '[]';
begin
  if not public.es_staff() then raise exception 'Solo el coordinador o administrador registra eventos.'; end if;
  if p_hasta <= p_desde or coalesce(array_length(p_rooms, 1), 0) = 0 then raise exception 'Indica espacios y un rango de fechas válido.'; end if;
  aff := public.affected_bookings(p_rooms, p_desde, p_hasta);
  select jsonb_agg(jsonb_build_object('id', id, 'room', code, 'block', block, 'asignatura', asignatura)) into cls from public.horario_fijo
   where code = any (p_rooms) and (p_desde::date <> p_hasta::date or (split_part(block, '-', 1)::int < ceil(extract(hour from p_hasta) + extract(minute from p_hasta) / 60.0) and split_part(block, '-', 2)::int > extract(hour from p_desde)));
  if not p_confirm then return jsonb_build_object('afectadas', aff, 'clases', coalesce(cls, '[]')); end if;
  insert into public.eventos(nombre, responsable, rooms, desde, hasta, asistentes, creado_por) values (p_nombre, p_resp, p_rooms, p_desde, p_hasta, p_asist, auth.uid()) returning id into ev;
  foreach r in array p_rooms loop
    insert into public.bloqueos(room, desde, hasta, tipo, motivo, evento_id, creado_por) values (r, p_desde, p_hasta, 'evento', 'Evento: ' || p_nombre, ev, auth.uid());
  end loop;
  for b in select x.id, x.room, x.date, x.slot, x.asistentes from public.bookings x where x.id in (select (e->>'id')::bigint from jsonb_array_elements(aff) e) loop
    update public.bookings set estado = 'cancelada', novedad = 'Cancelada por evento institucional: ' || p_nombre where id = b.id;
    alts := alts || jsonb_build_object('reserva', b.id, 'alternativas', public.suggest_alternatives(b.room, b.date, b.slot, b.asistentes, '{}'));
  end loop;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'evento', 'evento:' || ev, jsonb_build_object('nombre', p_nombre, 'canceladas', jsonb_array_length(aff)));
  return jsonb_build_object('evento', ev, 'afectadas', aff, 'clases', coalesce(cls, '[]'), 'alternativas', alts);
end $$;

-- RF20 inventario: espacios y recursos
create or replace function public.upsert_salon(p_code text, p_label text, p_tipo text, p_piso int, p_sillas int, p_ubic text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.es_staff() then raise exception 'Solo el coordinador gestiona el inventario.'; end if;
  update public.salones set label = p_label, tipo = p_tipo, piso = p_piso, sillas = p_sillas, ubicacion = p_ubic where code = p_code;
  if not found then insert into public.salones(code, label, tipo, piso, sillas, ubicacion) values (p_code, p_label, p_tipo, p_piso, p_sillas, p_ubic); end if;
end $$;
create or replace function public.set_salon_activo(p_code text, p_activo boolean) returns int language plpgsql security definer set search_path = public as $$
begin
  if not public.es_staff() then raise exception 'Solo el coordinador gestiona el inventario.'; end if;
  update public.salones set activo = p_activo where code = p_code;
  return (select count(*) from public.bookings where room = p_code and estado in ('pendiente','confirmada') and date >= (now() at time zone 'America/Bogota')::date);
end $$;
create or replace function public.upsert_recurso(p_id bigint, p_room text, p_tipo text, p_cantidad int, p_operativos int, p_estado text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_maint() then raise exception 'No tienes permiso para gestionar el inventario.'; end if;
  if p_operativos > p_cantidad then raise exception 'Los equipos operativos no pueden superar la cantidad.'; end if;
  if p_id is null then
    insert into public.recursos(room, tipo, cantidad, operativos, estado, activo) values (p_room, trim(p_tipo), p_cantidad, p_operativos, p_estado, p_estado <> 'baja');
  else
    update public.recursos set tipo = trim(p_tipo), cantidad = p_cantidad, operativos = p_operativos, estado = p_estado, activo = (p_estado <> 'baja') where id = p_id;
  end if;
end $$;

revoke execute on function public.affected_bookings(text[],timestamp,timestamp), public.es_staff(), public.can_maint() from public, anon;
grant execute on function public.report_damage(text,text,text), public.update_report(bigint,text,text,text), public.create_block(text,timestamp,timestamp,text,text),
  public.unblock(bigint), public.suggest_alternatives(text,date,text,int,text[]), public.create_event(text,text,text[],timestamp,timestamp,int,boolean),
  public.upsert_salon(text,text,text,int,int,text), public.set_salon_activo(text,boolean), public.upsert_recurso(bigint,text,text,int,int,text) to authenticated;
