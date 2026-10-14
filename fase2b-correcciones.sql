-- FASE 2B · Correcciones de lo parcial: privacidad, límites editables, edición de usuarios, reservas antiguas.
-- Ejecutar DESPUÉS de fase2-reservas.sql. Aditivo: no borra datos.
do $$ begin
  alter table public.reglas add constraint reglas_valor_positivo check (valor >= 1);
exception when duplicate_object then null; end $$;

-- Privacidad: cada usuario lee solo sus reservas; el coordinador/administrador lee todas.
drop policy if exists bookings_leer on public.bookings;
create policy bookings_leer on public.bookings for select to authenticated
  using (user_id = auth.uid() or public.current_rol() in ('coordinador','administrador'));
-- La disponibilidad se consulta por una vista SIN documento, motivo ni nombre de nadie.
create or replace view public.bookings_ocupacion as
  select id, date, room, slot, estado, (user_id = auth.uid()) as mine from public.bookings;
grant select on public.bookings_ocupacion to authenticated;

-- Reservas anteriores sin user_id: se vinculan solo si el nombre coincide con UN único perfil.
update public.bookings b set user_id = p.id from public.profiles p
 where b.user_id is null and lower(trim(b.app_user)) = lower(trim(p.nombre))
   and (select count(*) from public.profiles q where lower(trim(q.nombre)) = lower(trim(b.app_user))) = 1;
-- Si alguna quedó sin vincular, hazlo a mano: update public.bookings set user_id = '<uuid del perfil>' where id = 8;

create or replace function public.admin_update_user(p_user uuid, p_nombre text, p_documento text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_rol() is distinct from 'administrador' then raise exception 'Solo el administrador puede hacer esto.'; end if;
  if length(trim(coalesce(p_nombre,''))) < 3 then raise exception 'Escribe el nombre completo.'; end if;
  update public.profiles set nombre = trim(p_nombre), documento = nullif(trim(p_documento),'') where id = p_user;
  insert into public.auditoria(actor, accion, objetivo, detalle) values (auth.uid(), 'editar_usuario', 'user:' || p_user, jsonb_build_object('nombre', p_nombre));
exception when unique_violation then raise exception 'Ese documento ya está registrado.';
end $$;
grant execute on function public.admin_update_user(uuid,text,text) to authenticated;
