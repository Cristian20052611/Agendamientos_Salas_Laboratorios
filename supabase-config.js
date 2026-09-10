// ============================================================
// CONFIGURACIÓN DE SUPABASE (base de datos Postgres)
// ============================================================
// 1. Ve a https://supabase.com, crea una cuenta gratis y un proyecto nuevo.
// 2. Dentro del proyecto, ve al ícono de la terminal "SQL Editor" y pega
//    el script que está en tabla-bookings.sql para crear la tabla.
// 3. Ve a "Project Settings" (engranaje) > "API". Ahí vas a ver:
//      - "Project URL"        -> pégalo en SUPABASE_URL
//      - "anon public" apikey -> pégalo en SUPABASE_ANON_KEY
// ============================================================

const SUPABASE_URL = "https://evxzfkogggvqlqfalfkq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_E7rrjuRDMdkWc-8SnPMb6A_LCq1NL0c";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
