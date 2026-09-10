// ============================================================
// CONFIGURACIÓN DE EMAILJS (correo de notificación al coordinador)
// ============================================================
// 1. Crea una cuenta gratis en https://www.emailjs.com
// 2. "Email Services" > Add New Service > Gmail > conecta la cuenta
//    cordinacionpruebasasl@gmail.com. Copia el "Service ID" y pégalo abajo.
// 3. "Email Templates" > Create New Template. En el cuerpo del correo usa
//    estas variables (tal cual, con las llaves dobles):
//
//      Se agendó la sala {{sala}}
//      Fecha: {{fecha}}
//      Hora: {{hora}}
//      Agendado por: {{usuario}} (documento {{documento}})
//      Motivo/materia: {{materia}}
//
//      Para confirmar esta reserva entra aquí: {{confirm_link}}
//
//    En el destinatario ("To email") pon: cordinacionpruebasasl@gmail.com
//    Copia el "Template ID" y pégalo abajo.
// 4. "Account" > "General" > copia tu "Public Key" y pégala abajo.
// ============================================================

const EMAILJS_PUBLIC_KEY = "t-2jDKlxmME0Ugr9J";
const EMAILJS_SERVICE_ID = "service_dzasfth";
const EMAILJS_TEMPLATE_ID = "template_rfg6qna";

emailjs.init(EMAILJS_PUBLIC_KEY);
