-- FASE 1 · Autenticación y roles (RF01, RF02, RF03, RF28, RF29). Aditivo: no borra ni renombra nada.
-- Ejecutar en Supabase > SQL Editor.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  documento text unique,
  email text not null,
  rol text not null default 'estudiante'
    check (rol in ('estudiante','docente','coordinador','administrador','mantenimiento')),
  activo boolean not null default true,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
alter table public.bookings add column if not exists user_id uuid references auth.users(id);

-- El rol que llega del navegador solo puede ser estudiante o docente; coordinador/administrador se asignan por admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := new.raw_user_meta_data->>'rol';
begin
  insert into public.profiles(id, nombre, documento, email, rol)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'nombre',''), split_part(new.email,'@',1)),
          nullif(new.raw_user_meta_data->>'documento',''),
          lower(new.email),
          case when r in ('estudiante','docente') then r else 'estudiante' end);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.current_rol() returns text
language sql stable security definer set search_path = public as
$$ select rol from public.profiles where id = auth.uid() and activo $$;

alter table public.profiles enable row level security;
drop policy if exists "perfil propio o staff" on public.profiles;
create policy "perfil propio o staff" on public.profiles for select
  using (id = auth.uid() or public.current_rol() in ('coordinador','administrador'));
drop policy if exists "admin edita perfiles" on public.profiles;
create policy "admin edita perfiles" on public.profiles for update
  using (public.current_rol() = 'administrador') with check (public.current_rol() = 'administrador');

-- RF29: 5 intentos fallidos consecutivos -> bloqueo de 15 min.
create or replace function public.login_status(p_email text) returns timestamptz
language sql security definer set search_path = public as
$$ select case when locked_until > now() then locked_until end from public.profiles where email = lower(p_email) $$;

create or replace function public.register_login_failure(p_email text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where email = lower(p_email) for update;
  if not found then return null; end if;
  if p.locked_until is not null and p.locked_until <= now() then
    p.failed_attempts := 0; p.locked_until := null;
  end if;
  p.failed_attempts := p.failed_attempts + 1;
  if p.failed_attempts >= 5 then
    p.locked_until := now() + interval '15 minutes'; p.failed_attempts := 0;
  end if;
  update public.profiles set failed_attempts = p.failed_attempts, locked_until = p.locked_until where id = p.id;
  return p.locked_until;
end $$;

create or replace function public.reset_login_attempts() returns void
language sql security definer set search_path = public as
$$ update public.profiles set failed_attempts = 0, locked_until = null where id = auth.uid() $$;

grant execute on function public.login_status(text), public.register_login_failure(text) to anon, authenticated;
grant execute on function public.reset_login_attempts() to authenticated;

-- PRIMER COORDINADOR / ADMIN: regístralo desde la app y luego ejecuta (cambia el correo):
--   update public.profiles set rol = 'coordinador' where email = 'cordinacionpruebasasl@gmail.com';
--   update public.profiles set rol = 'administrador' where email = 'tu_correo@...';
