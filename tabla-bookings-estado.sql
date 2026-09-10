-- Ejecuta esto en Supabase: Panel del proyecto > SQL Editor > New query > Run
-- Agrega el estado de confirmación a las reservas (bookings) que ya tienes.

alter table bookings add column if not exists estado text not null default 'pendiente';
alter table bookings add column if not exists confirm_token uuid not null default gen_random_uuid();

-- Para que el botón "Confirmar" del correo pueda actualizar el estado desde el
-- navegador (con la misma anon key que usa el resto de la app):
create policy "Permitir confirmacion" on bookings
  for update using (true) with check (true);
