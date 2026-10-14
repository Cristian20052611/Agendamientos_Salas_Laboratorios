# Informe de cumplimiento RF01–RF40 — Agendamiento de salas y laboratorios

Orden de instalación en Supabase (SQL Editor): `fase1-auth.sql` → `fase2-reservas.sql` → `fase2b-correcciones.sql` → `fase3-operacion.sql` → `fase4-espacios.sql` → `fase5-reportes.sql`. Luego publicar el proyecto.

| RF | Estado | Qué se hizo |
|---|---|---|
| 01 Registro | Agregado | Formulario con validaciones; trigger crea el perfil; solo estudiante/docente por autoregistro. |
| 02 Inicio de sesión | Corregido | Supabase Auth real; antes aceptaba cualquier clave. Sesión persistente. |
| 03 Roles | Agregado | Tabla `profiles` con 5 roles; el coordinador ya no está en el código. |
| 04 Consulta de espacios | Corregido | Se conservó el filtro por piso; se añadió búsqueda por nombre/código. |
| 05 Info del espacio | Corregido | La ficha suma recursos con cantidad y operativos. |
| 06 Disponibilidad | Corregido | Se conservó; ahora considera bloqueos y estados. |
| 07 Reservar | Corregido | Se conservó el flujo; ahora por función de servidor con asistentes. |
| 08 Revalidar | Agregado | El servidor revalida al guardar y al confirmar. |
| 09 Simultáneas | Corregido | Índice único parcial en la base. |
| 10 Cancelar | Corregido | Cancelación suave (conserva historial). |
| 11 Modificar | Agregado | Ventana propia; revalida; vuelve a pendiente. |
| 12 Mis reservas | Corregido | Todos los estados, filtro y acciones. |
| 13 Confirmar/rechazar | Corregido | Se conservó confirmar; se añadió rechazo con motivo. |
| 14 Reglas | Corregido | Ventana de 30 días, bloques de 1 h, horarios y horas pasadas validados en servidor. |
| 15 Aforo | Agregado | Asistentes vs. sillas del espacio. |
| 16 Check-in | Agregado | Primeros 15 minutos. Solo reservas; no clases fijas. |
| 17 Liberación | Agregado | Perezosa al abrir la app; `pg_cron` opcional. |
| 18 Clases fijas | Parcial | CRUD previo conservado + cambio de salón + carga masiva. Falta vigencia por periodo. |
| 19 Carga masiva | Agregado | Clases, espacios y recursos desde Excel/CSV con reporte de filas inválidas. |
| 20 Inventario | Agregado | Espacios y recursos: alta, edición, baja. |
| 21 Reporte de daños | Agregado | Cualquier usuario; bloquea el espacio. |
| 22 Bloqueo/desbloqueo | Agregado | Con lista de reservas afectadas. |
| 23 Cambio de salón | Agregado | Para reservas y clases fijas. |
| 24 Notificaciones | Parcial | Notificaciones dentro de la app para todos los eventos; correo solo al coordinador (existente) y bloqueo (opcional). |
| 25 Alertas | Agregado | "Avisarme" en horarios ocupados y sin alternativas. No avisa al desbloquear un espacio. |
| 26 Calendario | Agregado | Vista semanal por espacio. Sin vista mensual. |
| 27 Histórico y reportes | Agregado | Filtros, uso, ocupación, demanda e inasistencias. |
| 28 Recuperar contraseña | Agregado | Enlace de un solo uso. |
| 29 Bloqueo por intentos | Parcial | 5 intentos → 15 min. Aplicado desde el cliente; falta hook de servidor. |
| 30 Gestión de usuarios | Agregado | Crear, editar, rol, activar/desactivar. |
| 31 Recurrentes | Agregado | 2–4 fechas, cada una validada. |
| 32 Límite por usuario | Agregado | Editable por el coordinador. |
| 33 Alternativas | Agregado | Hasta 5, cercanas primero. |
| 34 Filtro por recursos | Agregado | Recurso, mínimo, aforo, sin bloqueo. |
| 35 Extender | Agregado | Desde 15 min antes del fin. |
| 36 Check-out | Agregado | Con novedad abre reporte de daño. |
| 37 Inasistencias | Parcial | 3 en 30 días → 7 días de suspensión; aviso solo dentro de la app. |
| 38 Seguimiento de daños | Agregado | Estados, responsable, historial. |
| 39 Eventos | Agregado | Bloquea, cancela reservas, sugiere alternativas. |
| 40 Exportación | Agregado | Excel (4 hojas) y PDF, con registro de auditoría. |

## Cambios en la base de datos (todos aditivos)
Tablas nuevas: `profiles`, `reglas`, `auditoria`, `reportes_dano`, `recursos`, `bloqueos`, `eventos`, `reporte_historial`, `notificaciones`, `alertas`. Vista: `bookings_ocupacion`.
Columnas nuevas: `bookings` (user_id, motivo_rechazo, asistentes, checkin_at, checkout_at, novedad, serie_id, contada), `salones` (activo), `profiles` (suspendido_hasta).
Cambio de seguridad: se reemplazaron las políticas abiertas de `bookings`; la escritura es solo vía funciones. No se borró ningún dato.

## Pruebas realizadas
- Sintaxis de JS (`node --check`) y de los 6 SQL (analizador de PostgreSQL) en cada fase.
- Verificación de que todos los elementos HTML referenciados existen.
- Prueba de humo en navegador simulado (jsdom) con Supabase simulado: carga, alternancia login/registro/recuperación, ingreso como estudiante y coordinador, apertura de todos los paneles. Sin errores de ejecución.
- **No probado:** las funciones SQL contra una base real, el envío de correos, y la exportación Excel/PDF en un navegador real.
