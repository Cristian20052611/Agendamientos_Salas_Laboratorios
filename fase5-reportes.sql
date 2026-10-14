-- FASE 5 · Notificaciones, alertas, reportes, exportación y carga masiva (RF19, 24, 25, 26, 27, 40).
-- Ejecutar DESPUÉS de fase4-espacios.sql. Aditivo: no borra datos.
create table if not exists public.notificaciones (id bigserial primary key, user_id uuid not null, tipo text, mensaje text not null,
  booking_id bigint, leida boolean not null default false, created_at timestamptz not null default now());
create index if not exists notif_user_idx on public.notificaciones(user_id, leida);
create table if not exists public.alertas (id bigserial primary key, user_id uuid not null, room text not null, date date not null, slot text not null,
  activa boolean not null default true, created_at timestamptz not null default now());
create unique index if not exists alertas_unica on public.alertas(user_id, room, date, slot) where activa;
alter table public.notificaciones enable row level security; alter table public.alertas enable row level security;
drop policy if exists notif_ver on public.notificaciones; create policy notif_ver on public.notificaciones for select using (user_id = auth.uid());
drop policy if exists notif_leer on public.notificaciones; create policy notif_leer on public.notificaciones for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists alertas_ver on public.alertas; create policy alertas_ver on public.alertas for select using (user_id = auth.uid());

-- RF24 + RF25: una sola función dispara los avisos del ciclo de vida de la reserva y las alertas de disponibilidad
create or replace function public.trg_booking_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare d text; dold text; msg text;
begin
  d := new.date::text || ' ' || new.slot || ' · ' || coalesce((select label from public.salones where code = new.room), new.room);
  if tg_op = 'INSERT' then
    if new.estado = 'pendiente' then
      if new.user_id is not null then
        insert into public.notificaciones(user_id, tipo, mensaje, booking_id) values (new.user_id, 'creada', 'Solicitud de reserva creada: ' || d || '. Queda pendiente de confirmación.', new.id);
      end if;
      insert into public.notificaciones(user_id, tipo, mensaje, booking_id)
        select id, 'pendiente', 'Nueva solicitud pendiente: ' || d || ' (' || coalesce(new.app_user,'') || ')', new.id from public.profiles where rol in ('coordinador','administrador') and activo;
    end if;
    return new;
  end if;
  if new.user_id is not null then
    if new.estado is distinct from old.estado then
      msg := case new.estado
        when 'confirmada' then 'Tu reserva fue confirmada: ' || d
        when 'rechazada' then 'Tu reserva fue rechazada: ' || d || coalesce('. Motivo: ' || new.motivo_rechazo, '')
        when 'cancelada' then 'Reserva cancelada: ' || d || coalesce('. ' || new.novedad, '')
        when 'no_asistio' then 'Tu reserva fue liberada automáticamente por inasistencia: ' || d
        else null end;
    end if;
    if (new.date, new.slot) is distinct from (old.date, old.slot) then msg := 'Reserva modificada: ' || d || '. Queda pendiente de confirmación.';
    elsif new.room is distinct from old.room then msg := 'Tu reserva fue reasignada a otro espacio: ' || d; end if;
    if msg is not null then insert into public.notificaciones(user_id, tipo, mensaje, booking_id) values (new.user_id, 'reserva', msg, new.id); end if;
  end if;
  if old.estado in ('pendiente','confirmada') and (new.estado not in ('pendiente','confirmada') or (new.room, new.date, new.slot) is distinct from (old.room, old.date, old.slot)) then
    dold := old.date::text || ' ' || old.slot || ' · ' || coalesce((select label from public.salones where code = old.room), old.room);
    with a as (update public.alertas set activa = false where activa and room = old.room and date = old.date and slot = old.slot and date >= current_date returning user_id)
    insert into public.notificaciones(user_id, tipo, mensaje) select user_id, 'disponible', 'Se liberó un espacio que esperabas: ' || dold || '. Reserva ya.' from a;
  end if;
  return new;
end $$;
drop trigger if exists bk_notify on public.bookings;
create trigger bk_notify after insert or update on public.bookings for each row execute function public.trg_booking_notify();

create or replace function public.trg_hist_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare d public.reportes_dano;
begin
  select * into d from public.reportes_dano where id = new.reporte_id;
  if d.reportado_por is not null and new.actor is distinct from d.reportado_por then
    insert into public.notificaciones(user_id, tipo, mensaje) values (d.reportado_por, 'dano', 'Tu reporte de daño (' || d.room || ') cambió a: ' || coalesce(new.estado, '') || coalesce('. ' || nullif(new.observacion,''), ''));
  end if;
  return new;
end $$;
drop trigger if exists hist_notify on public.reporte_historial;
create trigger hist_notify after insert on public.reporte_historial for each row execute function public.trg_hist_notify();

create or replace function public.trg_susp_notify() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.suspendido_hasta is not null and new.suspendido_hasta > now() and old.suspendido_hasta is distinct from new.suspendido_hasta then
    insert into public.notificaciones(user_id, tipo, mensaje) values (new.id, 'suspension', 'Quedaste suspendido para reservar hasta ' || to_char(new.suspendido_hasta at time zone 'America/Bogota', 'DD/MM/YYYY HH24:MI') || ' por inasistencias reiteradas.');
  elsif new.suspendido_hasta is null and old.suspendido_hasta is not null then
    insert into public.notificaciones(user_id, tipo, mensaje) values (new.id, 'suspension', 'Tu suspensión fue levantada. Ya puedes reservar.');
  end if;
  return new;
end $$;
drop trigger if exists susp_notify on public.profiles;
create trigger susp_notify after update of suspendido_hasta on public.profiles for each row execute function public.trg_susp_notify();

create or replace function public.create_alert(p_room text, p_date date, p_slot text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and activo) then raise exception 'Debes iniciar sesión.'; end if;
  if p_date < current_date then raise exception 'Esa fecha ya pasó.'; end if;
  insert into public.alertas(user_id, room, date, slot) values (auth.uid(), p_room, p_date, p_slot);
exception when unique_violation then null;
end $$;

create or replace function public.log_export(p_tipo text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.es_staff() then raise exception 'Solo el coordinador exporta reportes.'; end if;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'exportar', p_tipo, '{}'::jsonb);
end $$;

-- RF19 carga masiva: valida fila por fila, importa las válidas y devuelve las inválidas (fila = número de fila en el archivo)
create or replace function public.bulk_import(p_tipo text, p_rows jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; i int := 1; ok int := 0; errs jsonb := '[]'; msg text; c text; blk text;
begin
  if not public.es_staff() then raise exception 'Solo el coordinador puede importar datos.'; end if;
  if p_tipo not in ('clases','espacios','recursos') then raise exception 'Tipo de carga inválido.'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'El archivo supera las 2000 filas.'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1; msg := null;
    begin
      if p_tipo = 'clases' then
        c := trim(r->>'code'); blk := trim(r->>'block');
        if not exists (select 1 from public.salones where code = c) then msg := 'El salón ' || coalesce(c,'') || ' no existe.';
        elsif blk is null or blk not in ('8-10','10-12','18-20','20-22') then msg := 'Bloque inválido (usa 8-10, 10-12, 18-20 o 20-22).';
        elsif coalesce(trim(r->>'asignatura'),'') = '' then msg := 'Falta la asignatura.';
        elsif exists (select 1 from public.horario_fijo where code = c and block = blk and asignatura = trim(r->>'asignatura') and coalesce(programa,'') = coalesce(trim(r->>'programa'),'') and coalesce(semestre,'') = coalesce(trim(r->>'semestre'),'')) then msg := 'Clase duplicada.';
        else
          insert into public.horario_fijo(id, code, block, jornada, programa, semestre, asignatura, docente)
          values ((select coalesce(max(id),0) + 1 from public.horario_fijo), c, blk, case when blk in ('8-10','10-12') then 'Diurna' else 'Nocturna' end,
                  trim(r->>'programa'), trim(r->>'semestre'), trim(r->>'asignatura'), trim(r->>'docente'));
        end if;
      elsif p_tipo = 'espacios' then
        c := trim(r->>'code');
        if coalesce(c,'') = '' or coalesce(trim(r->>'label'),'') = '' then msg := 'Faltan código o nombre.';
        elsif coalesce(nullif(r->>'tipo',''),'aula') not in ('aula','lab','especial') then msg := 'Tipo inválido (aula, lab o especial).';
        else perform public.upsert_salon(c, trim(r->>'label'), coalesce(nullif(r->>'tipo',''),'aula'), nullif(r->>'piso','')::int, nullif(r->>'sillas','')::int, nullif(trim(r->>'ubicacion'),''));
        end if;
      else
        c := trim(r->>'room');
        if not exists (select 1 from public.salones where code = c) then msg := 'El espacio ' || coalesce(c,'') || ' no existe.';
        elsif coalesce(trim(r->>'tipo'),'') = '' then msg := 'Falta el recurso.';
        elsif coalesce(nullif(r->>'operativos','')::int, 0) > coalesce(nullif(r->>'cantidad','')::int, 0) then msg := 'Los operativos superan la cantidad.';
        else
          update public.recursos set cantidad = coalesce(nullif(r->>'cantidad','')::int, 0), operativos = coalesce(nullif(r->>'operativos','')::int, 0),
                 estado = coalesce(nullif(r->>'estado',''),'operativo'), activo = true where room = c and lower(tipo) = lower(trim(r->>'tipo'));
          if not found then
            insert into public.recursos(room, tipo, cantidad, operativos, estado) values (c, trim(r->>'tipo'), coalesce(nullif(r->>'cantidad','')::int, 0), coalesce(nullif(r->>'operativos','')::int, 0), coalesce(nullif(r->>'estado',''),'operativo'));
          end if;
        end if;
      end if;
    exception when others then msg := 'Dato inválido en la fila.';
    end;
    if msg is null then ok := ok + 1; else errs := errs || jsonb_build_object('fila', i, 'motivo', msg); end if;
  end loop;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'carga_masiva', p_tipo, jsonb_build_object('importadas', ok, 'errores', jsonb_array_length(errs)));
  return jsonb_build_object('importadas', ok, 'errores', errs);
end $$;

grant execute on function public.create_alert(text,date,text), public.log_export(text), public.bulk_import(text,jsonb) to authenticated;
