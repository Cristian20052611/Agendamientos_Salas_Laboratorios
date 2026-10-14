# Agenda de Aulas y Laboratorios — Guía de instalación y uso

## A. Publicar la app (una sola vez)
1. Entra a https://app.netlify.com/drop (crea cuenta gratis para que el sitio no expire).
2. Arrastra ESTA carpeta (la que contiene index.html). Netlify te da una dirección https://....netlify.app
3. En Supabase > Authentication > URL Configuration:
   - Site URL: tu dirección de Netlify
   - Redirect URLs: tu dirección de Netlify seguida de /**
4. En Supabase > Authentication > proveedor Email: desactiva "Confirm email" (sin servicio de correo propio los registros se traban).

## B. Base de datos (solo la primera vez; ya hecho si todo funciona)
En Supabase > SQL Editor, correr en este orden, un archivo a la vez:
fase1-auth.sql → fase2-reservas.sql → fase2b-correcciones.sql → fase3-operacion.sql → fase4-espacios.sql → fase5-reportes.sql

Nota: si bookings.date es de tipo texto, convertirlo a date antes de la fase 4 (ver conversación de soporte).

## C. Crear el primer administrador
1. Registrarse en la app ("Crear cuenta").
2. En SQL Editor (cambiar el correo):
   update public.profiles set rol = 'administrador' where email = 'tu_correo@ejemplo.com';
3. Cerrar sesión y volver a entrar. Desde el botón "Usuarios" se crean las demás cuentas y roles.

## D. Antes de presentar
- Entrar al panel de Supabase uno o dos días antes: si el proyecto aparece "paused", restaurarlo.
- Probar desde otro dispositivo (por ejemplo el celular) con la dirección publicada.
- Llevar copia de este zip, los 6 archivos SQL y la lista de cuentas de prueba (USB o nube).

## E. Plan B sin internet de publicación (en el computador)
Doble clic en iniciar-local.bat (requiere Python). Abre http://localhost:5500
Limitación: la recuperación de contraseña por correo solo funciona con la app publicada.
