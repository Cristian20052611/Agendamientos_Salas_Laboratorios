(function(){

  // ---------- ROOM DATA ----------
  // El inventario de salones y el horario fijo YA NO están escritos aquí:
  // ahora viven en la base de datos (tablas "salones" y "horario_fijo" en Supabase,
  // ver tabla-salones-horario.sql). Estos arreglos se llenan al vuelo con loadStaticData().
  var ROOMS = [];
  var HORARIO_FIJO = [];
  var RECURSOS = [];
  var BLOQUEOS = [];

  // Convierte una fila de la tabla "salones" al mismo formato de objeto que usaba
  // antes el arreglo ROOMS hardcodeado, para no tocar el resto del código.
  function rowToRoom(r){
    return {
      code: r.code,
      activo: r.activo !== false,
      piso: r.piso === null ? undefined : r.piso,
      tipo: r.tipo,
      label: r.label,
      sillas: r.sillas === null ? undefined : r.sillas,
      equipo: r.equipo === null ? undefined : r.equipo,
      videoBeam: r.video_beam === null ? undefined : r.video_beam,
      metraje: r.metraje === null ? undefined : r.metraje,
      ubicacion: r.ubicacion === null ? undefined : r.ubicacion,
      nota: r.nota === null ? undefined : r.nota
    };
  }

  // Carga salones + horario fijo desde Supabase. Se llama una sola vez al abrir la app.
  function loadStaticData(){
    var sb = getSupabase();
    if(!sb) return Promise.resolve();
    var salonesP = sb.from('salones').select('*').then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo cargar el inventario de salones.');
        return;
      }
      ROOMS = (res.data || []).map(rowToRoom).filter(function(r){ return r.activo; });
    });
    var horarioP = sb.from('horario_fijo').select('*').then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo cargar el horario fijo.');
        return;
      }
      HORARIO_FIJO = res.data || [];
    });
    var recP = sb.from('recursos').select('*').eq('activo', true).then(function(r){ RECURSOS = r.data || []; });
    var blkP = sb.from('bloqueos').select('*').eq('activo', true).then(function(r){ BLOQUEOS = r.data || []; });
    return Promise.all([salonesP, horarioP, recP, blkP]);
  }
  var staticDataPromise = loadStaticData();

  // Clases fijas de la universidad: bloques de 2 horas en la mañana y en la noche
  var MORNING_BLOCKS = [
    {key:'8-10', label:'8:00 – 10:00'},
    {key:'10-12', label:'10:00 – 12:00'}
  ];
  var EVENING_BLOCKS = [
    {key:'18-20', label:'18:00 – 20:00'},
    {key:'20-22', label:'20:00 – 22:00'}
  ];

  // Único bloque realmente libre para agendar en los salones normales: 12:00–18:00
  var SLOTS_TARDE = [
    '12:00-13:00','13:00-14:00','14:00-15:00','15:00-16:00','16:00-17:00','17:00-18:00'
  ];
  // Los laboratorios se agendan solo en el bloque nocturno
  var LAB_ONLY_SLOTS = ['18:00-19:00','19:00-20:00','20:00-21:00','21:00-22:00'];

  // Duración del módulo: hoy + 30 días
  var MODULE_DAYS = 30;

  // ---------- HORARIO FIJO (datos reales, ver horario-fijo.js) ----------
  // Todas las clases fijas que caen en un salón + bloque determinado (normalmente 1,
  // a veces varias si el mismo curso se dicta a más de un programa a la vez).
  function fixedClassesFor(room, blockKey){
    return HORARIO_FIJO.filter(function(h){ return h.code === room.code && h.block === blockKey; });
  }
  function blockOccupied(room, dateStr, blockKey){
    return fixedClassesFor(room, blockKey).length > 0;
  }
  function blockSubject(room, dateStr, blockKey){
    var clases = fixedClassesFor(room, blockKey);
    if(clases.length === 0) return '';
    return clases.map(function(c){ return c.asignatura + ' — ' + c.programa + ' (' + c.docente + ')'; }).join(' · ');
  }

  // ---------- STATE ----------
  var state = {
    user: null,
    profile: null,
    franja: 'manana',
    piso: 'todos',
    date: todayStr(),
    bookings: [],       // reservas del día que se está viendo en el modal de horas
    calMonth: null,     // {year, month} mes que se muestra en el calendario del modal
    calDate: null        // fecha elegida dentro del modal (para agendar)
  };

  function todayStr(d){
    d = d || new Date();
    var m = String(d.getMonth()+1).padStart(2,'0');
    var day = String(d.getDate()).padStart(2,'0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function parseDateStr(s){
    var parts = s.split('-');
    return new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
  }
  function addDays(dateStr, days){
    var d = parseDateStr(dateStr);
    d.setDate(d.getDate() + days);
    return todayStr(d);
  }
  function moduleEndStr(){
    return addDays(todayStr(), MODULE_DAYS);
  }

  // ---------- LOGIN / REGISTRO / RECUPERACIÓN (Supabase Auth + tabla profiles) ----------
  var ROLES_PANEL = ['coordinador','administrador'];
  function el(id){ return document.getElementById(id); }
  function passwordOk(p){ return p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p); }
  function minsLeft(until){ return Math.max(1, Math.ceil((new Date(until) - new Date()) / 60000)); }
  function showAuthView(id){
    ['login-form','register-form','recover-form'].forEach(function(f){ el(f).style.display = (f === id) ? '' : 'none'; });
  }
  el('go-register').addEventListener('click', function(e){ e.preventDefault(); showAuthView('register-form'); });
  el('go-recover').addEventListener('click', function(e){ e.preventDefault(); showAuthView('recover-form'); });
  document.querySelectorAll('.go-login').forEach(function(a){
    a.addEventListener('click', function(e){ e.preventDefault(); showAuthView('login-form'); });
  });

  function enterApp(uid){
    var sb = getSupabase();
    return sb.from('profiles').select('*').eq('id', uid).single().then(function(res){
      var p = res.data;
      if(res.error || !p || !p.activo){
        sb.auth.signOut();
        el('login-error').textContent = 'Tu cuenta no está activa o no tiene perfil. Contacta al administrador.';
        showAuthView('login-form');
        return;
      }
      state.profile = p;
      state.user = p.nombre;
      startNotifPolling();
      el('login-screen').style.display = 'none';
      if(ROLES_PANEL.indexOf(p.rol) >= 0){ el('coord-susp-btn').style.display = ''; el('coord-inv-btn').style.display = ''; el('coord-blk-btn').style.display = ''; el('coord-dmg-btn').style.display = ''; el('coord-ev-btn').style.display = ''; el('coord-users-btn').style.display = p.rol === 'administrador' ? '' : 'none'; openCoordPanel(); return; }
      el('app-screen').style.display = 'block';
      el('damage-admin-btn').style.display = p.rol === 'mantenimiento' ? '' : 'none';
      el('user-name').textContent = p.nombre;
      el('user-avatar').textContent = p.nombre.slice(0,2).toUpperCase();
      el('date-picker').value = state.date;
      el('date-picker').min = todayStr();
      el('date-picker').max = moduleEndStr();
      return releaseNoShows().then(function(){ return staticDataPromise; }).then(function(){
        return loadBookingsForDate(state.date);
      }).then(function(list){
        state.bookings = list;
        renderRooms();
      });
    });
  }

  var loginForm = el('login-form');
  loginForm.addEventListener('submit', function(e){
    e.preventDefault();
    var sb = getSupabase();
    if(!sb) return;
    var email = el('login-user').value.trim().toLowerCase();
    var pass = el('login-pass').value;
    var errEl = el('login-error');
    if(!email || !pass){ errEl.textContent = 'Ingresa correo y contraseña.'; return; }
    errEl.textContent = '';
    sb.rpc('login_status', {p_email: email}).then(function(st){
      if(st.data){
        errEl.textContent = 'Cuenta bloqueada temporalmente. Intenta de nuevo en ' + minsLeft(st.data) + ' min.';
        return;
      }
      return sb.auth.signInWithPassword({email: email, password: pass}).then(function(res){
        if(res.error){
          return sb.rpc('register_login_failure', {p_email: email}).then(function(f){
            errEl.textContent = f.data
              ? 'Demasiados intentos fallidos. Cuenta bloqueada por ' + minsLeft(f.data) + ' min.'
              : 'Correo o contraseña incorrectos.';
            if(f.data) notifyLock(email, f.data);
          });
        }
        return sb.rpc('reset_login_attempts').then(function(){ return enterApp(res.data.user.id); });
      });
    });
  });

  el('register-form').addEventListener('submit', function(e){
    e.preventDefault();
    var sb = getSupabase();
    if(!sb) return;
    var errEl = el('register-error');
    var nombre = el('reg-nombre').value.trim();
    var doc = el('reg-doc').value.trim();
    var email = el('reg-email').value.trim().toLowerCase();
    var pass = el('reg-pass').value;
    if(nombre.length < 3){ errEl.textContent = 'Escribe tu nombre completo.'; return; }
    if(!/^\d{5,15}$/.test(doc)){ errEl.textContent = 'El número de identificación debe tener solo dígitos (5 a 15).'; return; }
    if(!passwordOk(pass)){ errEl.textContent = 'La contraseña debe tener al menos 8 caracteres, con letras y números.'; return; }
    if(pass !== el('reg-pass2').value){ errEl.textContent = 'Las contraseñas no coinciden.'; return; }
    errEl.textContent = '';
    sb.auth.signUp({email: email, password: pass, options: {data: {nombre: nombre, documento: doc, rol: el('reg-rol').value}}}).then(function(res){
      if(res.error){
        var m = (res.error.message || '').toLowerCase();
        errEl.textContent = m.indexOf('already') >= 0 ? 'Ya existe una cuenta con ese correo.'
          : m.indexOf('database') >= 0 ? 'No se pudo crear la cuenta: revisa que el documento no esté ya registrado.'
          : 'No se pudo crear la cuenta: ' + res.error.message;
        return;
      }
      if(res.data.session){ showToast('Cuenta creada. ¡Bienvenido!'); return enterApp(res.data.user.id); }
      showAuthView('login-form');
      el('login-error').textContent = 'Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.';
    });
  });

  el('recover-form').addEventListener('submit', function(e){
    e.preventDefault();
    var sb = getSupabase();
    if(!sb) return;
    var email = el('rec-email').value.trim().toLowerCase();
    sb.auth.resetPasswordForEmail(email, {redirectTo: baseUrl() + 'restablecer.html'}).then(function(){
      // Mismo mensaje exista o no el correo (no revela cuentas).
      el('recover-msg').textContent = 'Si el correo está registrado, te enviamos un enlace para restablecer la contraseña (vigencia máxima de 30 minutos).';
    });
  });

  function notifyLock(email, until){
    if(typeof emailjs === 'undefined' || typeof EMAILJS_TEMPLATE_BLOQUEO === 'undefined' || !EMAILJS_TEMPLATE_BLOQUEO) return;
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_BLOQUEO, {to_email: email, minutos: minsLeft(until), hasta: new Date(until).toLocaleTimeString('es-CO')}).catch(function(err){ console.error(err); });
  }
  function doLogout(){
    clearInterval(notifTimer);
    var sb = getSupabase();
    if(sb) sb.auth.signOut();
    state.user = null; state.profile = null;
  }
  // Restaura la sesión si ya estaba iniciada
  if(typeof supabaseClient !== 'undefined' && supabaseClient){
    supabaseClient.auth.getSession().then(function(r){
      if(r.data && r.data.session) enterApp(r.data.session.user.id);
    });
  }

  el('logout-btn').addEventListener('click', function(){
    doLogout();
    el('app-screen').style.display = 'none';
    el('login-screen').style.display = 'flex';
    showAuthView('login-form');
    el('login-user').value = '';
    el('login-pass').value = '';
  });

  var outId = null, rcTarget = null, lastSerie = null;
  function rpcDo(name, args, okMsg, after){
    return getSupabase().rpc(name, args).then(function(res){
      if(res.error){ rpcErr(res); return null; }
      if(okMsg) showToast(okMsg);
      if(after) after(res.data);
      return res;
    });
  }
  function refreshMine(){
    renderMyBookings();
    loadBookingsForDate(state.date).then(function(l){ state.bookings = l; renderRooms(); });
  }
  function releaseNoShows(){
    var sb = getSupabase();
    return sb ? sb.rpc('release_no_shows').then(function(){}, function(){}) : Promise.resolve();
  }
  function opButtons(b){
    if(b.estado !== 'confirmada') return '';
    if(!b.checkin_at) return b.date === todayStr() ? '<button class="slot-btn book" data-act="checkin" data-id="' + b.id + '">Check-in</button>' : '';
    return '<button class="slot-btn book" data-act="extend" data-id="' + b.id + '">Extender</button><button class="slot-btn book" data-act="out" data-id="' + b.id + '">Finalizar</button>';
  }
  function hide(id){ return function(){ el(id).style.display = 'none'; }; }
  el('out-close').addEventListener('click', hide('out-backdrop'));
  el('out-cancel').addEventListener('click', hide('out-backdrop'));
  el('out-save').addEventListener('click', function(){
    var ok = el('out-ok').value === 'ok', d = el('out-desc').value.trim();
    if(!ok && !d){ showToast('Describe la novedad.'); return; }
    rpcDo('checkout_booking', {p_id: outId, p_ok: ok, p_novedad: ok ? null : d}, 'Entrega registrada.', function(){ hide('out-backdrop')(); refreshMine(); });
  });
  function createSeries(doc, subj, asist){
    rpcDo('create_series', {p_room: activeRoom.code, p_first: state.calDate, p_slot: pendingSlot, p_reps: parseInt(el('booking-reps').value, 10) || 2, p_doc: doc, p_subject: subj, p_asistentes: asist}, null, function(r){
      lastSerie = r;
      el('serie-body').innerHTML = '<p><b>Reservadas (' + r.creadas.length + '):</b> ' + (r.creadas.join(', ') || 'ninguna') + '</p>' +
        (r.fallidas.length ? '<p><b>No se pudieron reservar:</b></p>' + r.fallidas.map(function(f){ return '<div class="slot-state">' + escapeHtml(f.fecha) + ' — ' + escapeHtml(f.motivo) + '</div>'; }).join('') : '');
      el('serie-backdrop').style.display = 'flex';
      closeBookingForm();
      selectCalendarDate(state.calDate);
      renderRooms();
    });
  }
  el('serie-keep').addEventListener('click', hide('serie-backdrop'));
  el('serie-drop').addEventListener('click', function(){
    rpcDo('cancel_series', {p_serie: lastSerie.serie}, 'Serie cancelada.', function(){ hide('serie-backdrop')(); selectCalendarDate(state.calDate); renderRooms(); });
  });
  function openRoomChange(kind, id){
    rcTarget = {kind: kind, id: id};
    el('rc-room').innerHTML = ROOMS.map(function(r){ return '<option value="' + r.code + '">' + escapeHtml(r.label) + '</option>'; }).join('');
    el('rc-motivo').value = '';
    el('rc-backdrop').style.display = 'flex';
  }
  el('rc-close').addEventListener('click', hide('rc-backdrop'));
  el('rc-cancel').addEventListener('click', hide('rc-backdrop'));
  el('rc-save').addEventListener('click', function(){
    var isB = rcTarget.kind === 'booking';
    rpcDo(isB ? 'change_room' : 'change_class_room', isB ? {p_id: rcTarget.id, p_new_room: el('rc-room').value, p_motivo: el('rc-motivo').value} : {p_class: rcTarget.id, p_new_room: el('rc-room').value, p_motivo: el('rc-motivo').value}, 'Cambio de salón realizado.', function(){
      hide('rc-backdrop')(); if(isB) renderAllBookings(); else { loadCoordTable(); staticDataPromise = loadStaticData(); }
    });
  });
  el('coord-susp-btn').addEventListener('click', function(){ el('susp-backdrop').style.display = 'flex'; renderSusp(); });
  el('susp-close').addEventListener('click', hide('susp-backdrop'));
  function renderSusp(){
    getSupabase().from('profiles').select('*').gt('suspendido_hasta', new Date().toISOString()).then(function(res){
      var list = el('susp-list'); list.innerHTML = '';
      if(!(res.data || []).length){ list.innerHTML = '<div class="content-sub">No hay usuarios suspendidos.</div>'; return; }
      res.data.forEach(function(u){
        var row = document.createElement('div'); row.className = 'slot-row';
        row.innerHTML = '<div><div class="slot-time">' + escapeHtml(u.nombre) + '</div><span class="slot-state">Hasta ' + new Date(u.suspendido_hasta).toLocaleString('es-CO') + '</span></div>' +
          '<div class="row-btns" style="flex:0 0 auto;"><input type="text" class="s-mot" placeholder="Motivo"><button class="slot-btn book" type="button">Levantar</button></div>';
        row.querySelector('button').addEventListener('click', function(){
          rpcDo('lift_suspension', {p_user: u.id, p_motivo: row.querySelector('.s-mot').value}, 'Suspensión levantada.', renderSusp);
        });
        list.appendChild(row);
      });
    });
  }

  var rejectingId = null;
  function closeReject(){ el('reject-backdrop').style.display = 'none'; }
  el('reject-close').addEventListener('click', closeReject);
  el('rej-cancel').addEventListener('click', closeReject);
  el('rej-save').addEventListener('click', function(){
    var motivo = el('rej-motivo').value.trim();
    if(!motivo){ showToast('Indica el motivo del rechazo.'); return; }
    getSupabase().rpc('decide_booking', {p_id: Number(rejectingId), p_decision: 'rechazada', p_motivo: motivo}).then(function(res){
      if(res.error){ rpcErr(res); return; }
      closeReject();
      showToast('Reserva rechazada; el espacio queda disponible.');
      renderAllBookings();
    });
  });

  // ---------- FASE 4: espacios, recursos, bloqueos, daños, eventos ----------
  function recursosOf(code){ return RECURSOS.filter(function(r){ return r.room === code; }); }
  function slotRange(d, slot){ var p = slot.split('-'); return [new Date(d + 'T' + p[0] + ':00'), new Date(d + 'T' + p[1] + ':00')]; }
  function blockedAt(room, d, slot){
    var r = slotRange(d, slot);
    return BLOQUEOS.filter(function(b){ return b.room === room.code && new Date(b.desde) < r[1] && new Date(b.hasta) > r[0]; })[0] || null;
  }
  function blockFor(room, d){
    var s = new Date(d + 'T00:00:00'), e = new Date(d + 'T23:59:59');
    return BLOQUEOS.filter(function(b){ return b.room === room.code && new Date(b.desde) <= e && new Date(b.hasta) >= s; })[0] || null;
  }
  function syncRecursoOptions(){
    var s = el('f-recurso'), tipos = [];
    RECURSOS.forEach(function(r){ if(tipos.indexOf(r.tipo) < 0) tipos.push(r.tipo); });
    tipos.sort();
    if(s.options.length === tipos.length + 1) return;
    var cur = s.value;
    s.innerHTML = '<option value="">Cualquier recurso</option>' + tipos.map(function(t){ return '<option>' + escapeHtml(t) + '</option>'; }).join('');
    s.value = cur;
  }
  ['f-search','f-recurso','f-min','f-aforo','f-ok'].forEach(function(id){
    el(id).addEventListener('input', renderRooms); el(id).addEventListener('change', renderRooms);
  });
  function attr(v){ return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function panel(title, html){ el('panel-title').textContent = title; el('panel-body').innerHTML = html; el('panel-backdrop').style.display = 'flex'; }
  el('panel-close').addEventListener('click', hide('panel-backdrop'));
  function fld(id, label, type, val){ return '<label for="' + id + '">' + label + '</label><input type="' + (type || 'text') + '" id="' + id + '" value="' + attr(val) + '">'; }
  function sel(id, label, items, cur, multi){
    return '<label for="' + id + '">' + label + '</label><select id="' + id + '"' + (multi ? ' multiple size="6"' : '') + '>' + items.map(function(i){
      var v = Array.isArray(i) ? i[0] : i, t = Array.isArray(i) ? i[1] : i;
      return '<option value="' + attr(v) + '"' + (v === cur ? ' selected' : '') + '>' + escapeHtml(t) + '</option>';
    }).join('') + '</select>';
  }
  function roomItems(){ return ROOMS.map(function(r){ return [r.code, r.label]; }); }
  function pv(id){ return el(id).value; }
  function reload(){ staticDataPromise = loadStaticData(); return staticDataPromise; }
  function affHtml(list, title){
    list = list || [];
    return '<p><b>' + title + '</b> ' + (list.length ? '' : 'ninguna') + '</p>' + list.map(function(a){ return '<div class="slot-state">' + escapeHtml(roomLabelByCode(a.room)) + ' · ' + a.date + ' · ' + a.slot + ' · ' + escapeHtml(a.usuario || '') + '</div>'; }).join('');
  }
  function altHtml(al){
    return al.length ? '<p><b>Alternativas sugeridas:</b></p>' + al.map(function(x){ return '<div class="slot-state">Reserva ' + x.reserva + ': ' + (x.alternativas.map(function(a){ return escapeHtml(a.label); }).join(', ') || 'sin alternativas') + '</div>'; }).join('') : '';
  }
  el('my-reports-btn').addEventListener('click', openMyReports);
  el('damage-admin-btn').addEventListener('click', openDamageAdmin);
  el('coord-dmg-btn').addEventListener('click', openDamageAdmin);
  el('coord-inv-btn').addEventListener('click', openInventory);
  el('coord-blk-btn').addEventListener('click', openBlocks);
  el('coord-ev-btn').addEventListener('click', openEvents);

  function showAlternatives(room, date, slot, asist, doc, subj){
    rpcDo('suggest_alternatives', {p_room: room, p_date: date, p_slot: slot, p_asist: asist, p_recursos: []}, null, function(list){
      panel('Espacios alternativos', list.length
        ? '<p>Libres en la misma fecha y horario (los más cercanos primero):</p>' + list.map(function(a){ return '<div class="slot-row"><div><div class="slot-time">' + escapeHtml(a.label) + '</div><span class="slot-state">Piso ' + a.piso + ' · aforo ' + (a.sillas == null ? '—' : a.sillas) + '</span></div><button class="slot-btn book alt" data-code="' + attr(a.code) + '" type="button">Reservar</button></div>'; }).join('')
        : '<p>No hay espacios alternativos disponibles para ese horario.</p><button class="btn-primary btn-confirm" id="alt-alert" type="button">Avisarme si se libera este horario</button>');
      var ab = el('alt-alert');
      if(ab) ab.addEventListener('click', function(){ createAlert(room, date, slot); });
      el('panel-body').querySelectorAll('.alt').forEach(function(b){
        b.addEventListener('click', function(){
          insertBooking(date, {room: b.getAttribute('data-code'), slot: slot, user: state.user, documento: doc, subject: subj, asistentes: asist}).then(function(nb){
            if(!nb) return;
            hide('panel-backdrop')(); closeModal();
            showToast('Solicitud enviada, pendiente de confirmación.');
            loadBookingsForDate(state.date).then(function(l){ state.bookings = l; renderRooms(); });
          });
        });
      });
    });
  }

  function openMyReports(){
    getSupabase().from('reportes_dano').select('*').eq('reportado_por', state.profile.id).order('created_at', {ascending: false}).then(function(res){
      panel('Reportar un daño', '<div class="booking-form open">' + sel('dr-room', 'Espacio', roomItems()) + sel('dr-tipo', 'Tipo de falla', ['Proyector','Aire acondicionado','Sillas','Luz','Red','Otro']) + fld('dr-desc', 'Descripción') +
        '<div class="row-btns"><button class="btn-primary btn-confirm" id="dr-send" type="button">Enviar reporte</button></div></div><div class="room-detail-title" style="margin-top:14px;">Mis reportes</div>' +
        ((res.data || []).map(function(r){ return '<div class="slot-row"><div><div class="slot-time">' + escapeHtml(roomLabelByCode(r.room)) + ' · ' + escapeHtml(r.tipo) + '</div><span class="slot-state">' + escapeHtml(r.descripcion || '') + ' · <b>' + escapeHtml(r.estado) + '</b>' + (r.responsable ? ' · Responsable: ' + escapeHtml(r.responsable) : '') + '</span></div></div>'; }).join('') || '<div class="content-sub">Aún no has reportado daños.</div>'));
      el('dr-send').addEventListener('click', function(){
        if(!pv('dr-desc').trim()){ showToast('Describe la falla.'); return; }
        rpcDo('report_damage', {p_room: pv('dr-room'), p_tipo: pv('dr-tipo'), p_desc: pv('dr-desc').trim()}, 'Reporte enviado; el espacio queda bloqueado hasta su revisión.', function(){ reload().then(function(){ renderRooms(); openMyReports(); }); });
      });
    });
  }

  function openDamageAdmin(){
    getSupabase().from('reportes_dano').select('*').order('created_at', {ascending: false}).then(function(res){
      var E = ['Reportado','En revisión','En reparación','Resuelto'];
      panel('Reportes de daño', (res.data || []).map(function(r){
        return '<div class="slot-row dmg" data-id="' + r.id + '" style="flex-wrap:wrap;"><div><div class="slot-time">' + escapeHtml(roomLabelByCode(r.room)) + ' · ' + escapeHtml(r.tipo) + '</div><span class="slot-state">' + escapeHtml(r.descripcion || '') + '</span></div>' +
          '<div class="row-btns" style="flex:0 0 auto;"><select class="d-est">' + E.map(function(e){ return '<option' + (e === r.estado ? ' selected' : '') + '>' + e + '</option>'; }).join('') + '</select><input class="d-resp" placeholder="Responsable" value="' + attr(r.responsable) + '"><input class="d-obs" placeholder="Observaciones"><button class="slot-btn book d-save" type="button">Guardar</button></div></div>';
      }).join('') || '<div class="content-sub">No hay reportes.</div>');
      el('panel-body').querySelectorAll('.dmg').forEach(function(row){
        row.querySelector('.d-save').addEventListener('click', function(){
          rpcDo('update_report', {p_id: Number(row.getAttribute('data-id')), p_estado: row.querySelector('.d-est').value, p_resp: row.querySelector('.d-resp').value, p_obs: row.querySelector('.d-obs').value}, 'Reporte actualizado.', function(r){
            if(r && r.bloqueo_id && state.profile.rol !== 'mantenimiento' && confirm('El reporte quedó Resuelto. ¿Desbloquear el espacio ahora?')){
              rpcDo('unblock', {p_id: r.bloqueo_id}, 'Espacio desbloqueado.', reload);
            }
            openDamageAdmin();
          });
        });
      });
    });
  }

  function openInventory(){
    getSupabase().from('salones').select('*').order('code').then(function(res){
      var rows = res.data || [];
      panel('Inventario de espacios', '<button class="btn-primary" id="inv-new" type="button" style="margin-bottom:10px;">+ Nuevo espacio</button>' + rows.map(function(s){
        var off = s.activo === false;
        return '<div class="slot-row" data-code="' + attr(s.code) + '"><div><div class="slot-time">' + escapeHtml(s.label) + (off ? ' (de baja)' : '') + '</div><span class="slot-state">Aforo: ' + (s.sillas == null ? '—' : s.sillas) + ' · ' + escapeHtml(s.tipo) + '</span></div>' +
          '<div class="row-btns" style="flex:0 0 auto;"><button class="slot-btn book i-res" type="button">Recursos</button><button class="slot-btn book i-edit" type="button">Editar</button><button class="slot-btn ' + (off ? 'book' : 'cancel') + ' i-act" type="button">' + (off ? 'Reactivar' : 'Dar de baja') + '</button></div></div>';
      }).join(''));
      el('inv-new').addEventListener('click', function(){ spaceForm(null); });
      el('panel-body').querySelectorAll('.slot-row').forEach(function(row){
        var s = rows.filter(function(x){ return x.code === row.getAttribute('data-code'); })[0], off = s.activo === false;
        row.querySelector('.i-edit').addEventListener('click', function(){ spaceForm(s); });
        row.querySelector('.i-res').addEventListener('click', function(){ resourcesPanel(s); });
        row.querySelector('.i-act').addEventListener('click', function(){
          if(!off && !confirm('El espacio dejará de recibir reservas. ¿Dar de baja?')) return;
          rpcDo('set_salon_activo', {p_code: s.code, p_activo: off}, null, function(n){
            showToast(off ? 'Espacio reactivado.' : 'Espacio dado de baja. Reservas futuras activas: ' + n + ' (resuélvelas con "Cambiar salón").');
            reload().then(function(){ renderRooms(); openInventory(); });
          });
        });
      });
    });
  }
  function spaceForm(s){
    panel(s ? 'Editar espacio' : 'Nuevo espacio', '<div class="booking-form open">' + fld('sp-code', 'Código', 'text', s && s.code) + fld('sp-label', 'Nombre', 'text', s && s.label) + sel('sp-tipo', 'Tipo', ['aula','lab','especial'], s && s.tipo) + fld('sp-piso', 'Piso', 'number', s && s.piso) + fld('sp-sillas', 'Aforo (capacidad)', 'number', s && s.sillas) + fld('sp-ubic', 'Ubicación', 'text', s && s.ubicacion) +
      '<div class="row-btns"><button class="btn-primary btn-confirm" id="sp-save" type="button">Guardar</button><button class="btn-primary btn-muted" id="sp-back" type="button">Volver</button></div></div>');
    if(s) el('sp-code').disabled = true;
    el('sp-back').addEventListener('click', openInventory);
    el('sp-save').addEventListener('click', function(){
      if(!pv('sp-code').trim() || !pv('sp-label').trim()){ showToast('Código y nombre son obligatorios.'); return; }
      rpcDo('upsert_salon', {p_code: pv('sp-code').trim(), p_label: pv('sp-label').trim(), p_tipo: pv('sp-tipo'), p_piso: parseInt(pv('sp-piso'), 10) || null, p_sillas: parseInt(pv('sp-sillas'), 10) || null, p_ubic: pv('sp-ubic').trim() || null}, 'Espacio guardado.', function(){ reload().then(function(){ renderRooms(); openInventory(); }); });
    });
  }
  function resourcesPanel(s){
    getSupabase().from('recursos').select('*').eq('room', s.code).eq('activo', true).order('tipo').then(function(res){
      var E = ['operativo','en reparación'];
      function rowHtml(r){
        return '<div class="slot-row rr" data-id="' + (r ? r.id : '') + '"><div class="row-btns"><input class="r-tipo" placeholder="Recurso (ej. Video beam)" value="' + attr(r && r.tipo) + '"><input class="r-cant" type="number" min="0" style="width:70px" title="Cantidad" value="' + (r ? r.cantidad : 1) + '"><input class="r-op" type="number" min="0" style="width:70px" title="Operativos" value="' + (r ? r.operativos : 1) + '"><select class="r-est">' + E.map(function(e){ return '<option' + (r && e === r.estado ? ' selected' : '') + '>' + e + '</option>'; }).join('') + '</select><button class="slot-btn book r-save" type="button">' + (r ? 'Guardar' : 'Agregar') + '</button>' + (r ? '<button class="slot-btn cancel r-del" type="button">Baja</button>' : '') + '</div></div>';
      }
      panel('Recursos · ' + s.label, '<div class="content-sub">Recurso · cantidad · operativos · estado</div>' + (res.data || []).map(rowHtml).join('') + rowHtml(null) + '<button class="btn-primary btn-muted" id="rs-back" type="button" style="margin-top:10px;">Volver</button>');
      el('rs-back').addEventListener('click', openInventory);
      el('panel-body').querySelectorAll('.rr').forEach(function(row){
        function save(baja){
          var t = row.querySelector('.r-tipo').value.trim();
          if(!t){ showToast('Escribe el recurso.'); return; }
          rpcDo('upsert_recurso', {p_id: row.getAttribute('data-id') ? Number(row.getAttribute('data-id')) : null, p_room: s.code, p_tipo: t, p_cantidad: parseInt(row.querySelector('.r-cant').value, 10) || 0, p_operativos: parseInt(row.querySelector('.r-op').value, 10) || 0, p_estado: baja ? 'baja' : row.querySelector('.r-est').value}, 'Recurso guardado.', function(){ reload().then(function(){ resourcesPanel(s); }); });
        }
        row.querySelector('.r-save').addEventListener('click', function(){ save(false); });
        var d = row.querySelector('.r-del'); if(d) d.addEventListener('click', function(){ save(true); });
      });
    });
  }

  function openBlocks(){
    getSupabase().from('bloqueos').select('*').eq('activo', true).order('desde').then(function(res){
      panel('Bloqueos de espacios', '<div class="booking-form open">' + sel('bl-room', 'Espacio', roomItems()) + fld('bl-desde', 'Desde', 'datetime-local') + fld('bl-hasta', 'Hasta', 'datetime-local') + sel('bl-tipo', 'Tipo', ['mantenimiento','evento','daño']) + fld('bl-motivo', 'Detalle') +
        '<div class="row-btns"><button class="btn-primary btn-confirm" id="bl-save" type="button">Bloquear</button></div></div><div id="bl-aff"></div><div class="room-detail-title" style="margin-top:14px;">Bloqueos activos</div>' +
        ((res.data || []).map(function(b){ return '<div class="slot-row"><div><div class="slot-time">' + escapeHtml(roomLabelByCode(b.room)) + ' · ' + escapeHtml(b.tipo) + '</div><span class="slot-state">' + escapeHtml(String(b.desde).replace('T', ' ').slice(0, 16)) + ' → ' + (String(b.hasta).slice(0, 4) === '9999' ? 'hasta que se desbloquee' : escapeHtml(String(b.hasta).replace('T', ' ').slice(0, 16))) + ' · ' + escapeHtml(b.motivo || '') + '</span></div><button class="slot-btn book b-un" data-id="' + b.id + '" type="button">Desbloquear</button></div>'; }).join('') || '<div class="content-sub">No hay bloqueos activos.</div>'));
      el('panel-body').querySelectorAll('.b-un').forEach(function(b){
        b.addEventListener('click', function(){ rpcDo('unblock', {p_id: Number(b.getAttribute('data-id'))}, 'Espacio desbloqueado.', function(){ reload().then(function(){ renderRooms(); openBlocks(); }); }); });
      });
      el('bl-save').addEventListener('click', function(){
        if(!pv('bl-desde') || !pv('bl-hasta')){ showToast('Indica desde y hasta.'); return; }
        rpcDo('create_block', {p_room: pv('bl-room'), p_desde: pv('bl-desde'), p_hasta: pv('bl-hasta'), p_tipo: pv('bl-tipo'), p_motivo: pv('bl-motivo')}, 'Espacio bloqueado.', function(r){
          reload().then(function(){ renderRooms(); });
          el('bl-aff').innerHTML = affHtml(r.afectadas, 'Reservas que cruzan el bloqueo (resuélvelas con "Cambiar salón" o "Cancelar" en Ver reservas):');
        });
      });
    });
  }

  function openEvents(){
    panel('Evento institucional', '<div class="booking-form open">' + fld('ev-nombre', 'Nombre del evento') + fld('ev-resp', 'Responsable') + sel('ev-rooms', 'Espacios (Ctrl/Cmd para varios)', roomItems(), null, true) + fld('ev-desde', 'Desde', 'datetime-local') + fld('ev-hasta', 'Hasta', 'datetime-local') + fld('ev-asist', 'Asistentes estimados', 'number') +
      '<div class="row-btns"><button class="btn-primary btn-muted" id="ev-prev" type="button">Ver reservas afectadas</button><button class="btn-primary btn-confirm" id="ev-ok" type="button">Confirmar evento</button></div></div><div id="ev-out"></div>');
    function run(c){
      var rooms = Array.prototype.map.call(el('ev-rooms').selectedOptions, function(o){ return o.value; });
      var a = {p_nombre: pv('ev-nombre').trim(), p_resp: pv('ev-resp').trim(), p_rooms: rooms, p_desde: pv('ev-desde'), p_hasta: pv('ev-hasta'), p_asist: parseInt(pv('ev-asist'), 10) || null, p_confirm: c};
      if(!a.p_nombre || !rooms.length || !a.p_desde || !a.p_hasta){ showToast('Completa nombre, espacios y fechas.'); return; }
      if(c && !confirm('Se cancelarán las reservas afectadas. ¿Confirmar el evento?')) return;
      rpcDo('create_event', a, c ? 'Evento registrado.' : null, function(r){
        var h = affHtml(r.afectadas, c ? 'Reservas canceladas:' : 'Reservas que se cancelarían:');
        if(r.clases && r.clases.length) h += '<p class="slot-state">Clases fijas en esos espacios (solo se mueven con "Cambiar salón"): ' + r.clases.map(function(x){ return escapeHtml(x.room + ' ' + x.block + ' ' + x.asignatura); }).join('; ') + '</p>';
        if(c && r.alternativas) h += altHtml(r.alternativas);
        el('ev-out').innerHTML = h;
        if(c) reload().then(function(){ renderRooms(); });
      });
    }
    el('ev-prev').addEventListener('click', function(){ run(false); });
    el('ev-ok').addEventListener('click', function(){ run(true); });
  }

  // ---------- FASE 5: notificaciones, alertas, calendario, reportes, exportación, carga masiva ----------
  var notifTimer = null;
  function updateNotifBadge(){
    var sb = getSupabase();
    if(!sb || !state.profile) return;
    sb.from('notificaciones').select('id', {count: 'exact', head: true}).eq('user_id', state.profile.id).eq('leida', false).then(function(r){
      var n = r.count || 0;
      ['notif-btn','coord-notif-btn'].forEach(function(id){ el(id).textContent = 'Notificaciones' + (n ? ' (' + n + ')' : ''); });
    });
  }
  function startNotifPolling(){ updateNotifBadge(); clearInterval(notifTimer); notifTimer = setInterval(updateNotifBadge, 60000); }
  function openNotifs(){
    getSupabase().from('notificaciones').select('*').eq('user_id', state.profile.id).order('created_at', {ascending: false}).limit(50).then(function(res){
      var d = res.data || [];
      panel('Notificaciones', (d.length ? '<button class="btn-primary btn-muted" id="nf-read" type="button" style="margin-bottom:10px;">Marcar todas como leídas</button>' : '') +
        (d.map(function(n){ return '<div class="slot-row"><div><div class="slot-time">' + (n.leida ? '' : '● ') + escapeHtml(n.mensaje) + '</div><span class="slot-state">' + new Date(n.created_at).toLocaleString('es-CO') + '</span></div></div>'; }).join('') || '<div class="content-sub">No tienes notificaciones.</div>'));
      var b = el('nf-read');
      if(b) b.addEventListener('click', function(){ getSupabase().from('notificaciones').update({leida: true}).eq('user_id', state.profile.id).eq('leida', false).then(function(){ updateNotifBadge(); openNotifs(); }); });
    });
  }
  function createAlert(room, date, slot){
    rpcDo('create_alert', {p_room: room, p_date: date, p_slot: slot}, 'Listo: te avisaremos por notificación si ese horario se libera.', function(){ hide('panel-backdrop')(); });
  }

  // RF26 calendario semanal de ocupación por espacio
  var calState = {room: null, monday: null};
  function ymd(x){ return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  function mondayOf(d){ var x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function openCalendar(code, mon){
    calState.room = code || calState.room || ROOMS[0].code;
    calState.monday = mon || calState.monday || mondayOf(todayStr());
    var room = ROOMS.filter(function(r){ return r.code === calState.room; })[0] || ROOMS[0], days = [];
    for(var i = 0; i < 7; i++){ var x = new Date(calState.monday); x.setDate(x.getDate() + i); days.push(x); }
    getSupabase().from('bookings_ocupacion').select('*').eq('room', room.code).gte('date', ymd(days[0])).lte('date', ymd(days[6])).in('estado', ['pendiente','confirmada']).then(function(res){
      var bk = {}, ok = slotsForRoom(room), COL = {libre: '#e8f5e9', reservada: '#ffd9d9', pendiente: '#fff3cd', clase: '#dbe7ff', bloqueada: '#e0e0e0', evento: '#ead6ff', na: '#fff'};
      (res.data || []).forEach(function(b){ bk[b.date + '|' + b.slot] = b; });
      var body = '';
      for(var h = 8; h < 22; h++){
        var slot = ('0' + h).slice(-2) + ':00-' + ('0' + (h + 1)).slice(-2) + ':00', key = h < 10 ? '8-10' : h < 12 ? '10-12' : (h >= 18 && h < 20) ? '18-20' : (h >= 20) ? '20-22' : null;
        body += '<tr><td style="padding:4px 6px;white-space:nowrap;">' + slot + '</td>' + days.map(function(dx, i){
          var ds = ymd(dx), st = 'na', t = '—', blk = blockedAt(room, ds, slot);
          if(blk){ st = blk.tipo === 'evento' ? 'evento' : 'bloqueada'; t = blk.tipo === 'evento' ? 'Evento' : 'Bloqueado'; }
          else if(i < 5 && key && fixedClassesFor(room, key).length){ st = 'clase'; t = 'Clase'; }
          else if(bk[ds + '|' + slot]){ var b = bk[ds + '|' + slot]; st = b.estado === 'confirmada' ? 'reservada' : 'pendiente'; t = b.mine ? 'Tu reserva' : (b.estado === 'confirmada' ? 'Reservada' : 'Pendiente'); }
          else if(ok.indexOf(slot) >= 0){ st = 'libre'; t = 'Libre'; }
          return '<td style="padding:4px 6px;text-align:center;background:' + COL[st] + ';border:1px solid #ddd;font-size:12px;">' + t + '</td>';
        }).join('') + '</tr>';
      }
      var head = days.map(function(dx, i){ return '<th style="padding:4px 6px;">' + ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'][i] + ' ' + dx.getDate() + '/' + (dx.getMonth() + 1) + '</th>'; }).join('');
      panel('Calendario · ' + room.label, '<div class="booking-form open">' + sel('cal-room', 'Espacio', roomItems(), room.code) + '<div class="row-btns"><button class="btn-primary btn-muted" id="cal-prev" type="button">‹ Semana anterior</button><button class="btn-primary btn-muted" id="cal-today" type="button">Hoy</button><button class="btn-primary btn-muted" id="cal-next" type="button">Semana siguiente ›</button></div></div>' +
        '<div style="overflow-x:auto;margin-top:10px;"><table style="border-collapse:collapse;width:100%;"><tr><th></th>' + head + '</tr>' + body + '</table></div><p class="slot-state">Libre · Reservada · Pendiente · Clase fija (lun–vie) · Bloqueado · Evento</p>');
      el('cal-room').addEventListener('change', function(){ openCalendar(pv('cal-room'), calState.monday); });
      function go(n){ var m = new Date(calState.monday); m.setDate(m.getDate() + n); openCalendar(null, m); }
      el('cal-prev').addEventListener('click', function(){ go(-7); });
      el('cal-next').addEventListener('click', function(){ go(7); });
      el('cal-today').addEventListener('click', function(){ openCalendar(null, mondayOf(todayStr())); });
    });
  }

  // RF27 histórico y reportes de uso + RF40 exportación
  var repData = {rows: [], sum: null, filtros: ''};
  var USADAS = ['confirmada','finalizada','finalizada_sin_registro'];
  function top(o, n){ return Object.keys(o).map(function(k){ return [k, o[k]]; }).sort(function(a, b){ return b[1] - a[1]; }).slice(0, n); }
  function summarize(rows, d1, d2){
    var days = Math.max(1, Math.round((new Date(d2) - new Date(d1)) / 86400000) + 1), byRoom = {}, bySlot = {}, byEst = {}, nos = {};
    rows.forEach(function(r){
      byEst[r.estado] = (byEst[r.estado] || 0) + 1;
      bySlot[r.slot] = (bySlot[r.slot] || 0) + 1;
      if(USADAS.indexOf(r.estado) >= 0) byRoom[r.room] = (byRoom[r.room] || 0) + 1;
      if(r.estado === 'no_asistio') nos[r.app_user || '—'] = (nos[r.app_user || '—'] || 0) + 1;
    });
    var uso = top(byRoom, 500).map(function(x){ var rm = ROOMS.filter(function(r){ return r.code === x[0]; })[0], cap = rm ? slotsForRoom(rm).length * days : 0; return {Espacio: roomLabelByCode(x[0]), 'Reservas usadas': x[1], 'Ocupación %': cap ? Math.round(1000 * x[1] / cap) / 10 : ''}; });
    return {estados: top(byEst, 20), uso: uso, demanda: top(bySlot, 10).map(function(x){ return {Franja: x[0], Solicitudes: x[1]}; }), inasist: top(nos, 20).map(function(x){ return {Usuario: x[0], Inasistencias: x[1]}; })};
  }
  function tbl(rows){
    if(!rows.length) return '<div class="content-sub">Sin datos.</div>';
    var k = Object.keys(rows[0]);
    return '<div style="overflow-x:auto;"><table style="border-collapse:collapse;font-size:13px;"><tr>' + k.map(function(c){ return '<th style="padding:3px 8px;text-align:left;">' + escapeHtml(c) + '</th>'; }).join('') + '</tr>' + rows.map(function(r){ return '<tr>' + k.map(function(c){ return '<td style="padding:3px 8px;border-top:1px solid #eee;">' + escapeHtml(r[c]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div>';
  }
  function detRow(r){ return {Fecha: r.date, Espacio: roomLabelByCode(r.room), Horario: r.slot, Usuario: r.app_user, Documento: r.documento, Motivo: r.subject, Asistentes: r.asistentes, Estado: r.estado}; }
  function openReports(){
    var d0 = new Date(); d0.setDate(d0.getDate() - 30);
    panel('Histórico y reportes de uso', '<div class="booking-form open">' + fld('rp-desde', 'Desde', 'date', ymd(d0)) + fld('rp-hasta', 'Hasta', 'date', todayStr()) + sel('rp-room', 'Espacio', [['', 'Todos']].concat(roomItems())) + fld('rp-user', 'Usuario (nombre contiene)') +
      sel('rp-estado', 'Estado', [['', 'Todos'], 'pendiente', 'confirmada', 'rechazada', 'cancelada', 'no_asistio', 'finalizada', 'finalizada_sin_registro']) +
      '<div class="row-btns"><button class="btn-primary btn-confirm" id="rp-run" type="button">Consultar</button><button class="btn-primary btn-muted" id="rp-xls" type="button">Exportar Excel</button><button class="btn-primary btn-muted" id="rp-pdf" type="button">Exportar PDF</button></div></div><div id="rp-out"></div>');
    el('rp-run').addEventListener('click', function(){
      var d1 = pv('rp-desde'), d2 = pv('rp-hasta');
      if(!d1 || !d2 || d1 > d2){ showToast('Revisa el rango de fechas.'); return; }
      var q = getSupabase().from('bookings').select('*').gte('date', d1).lte('date', d2).order('date').limit(5000);
      if(pv('rp-room')) q = q.eq('room', pv('rp-room'));
      if(pv('rp-estado')) q = q.eq('estado', pv('rp-estado'));
      if(pv('rp-user').trim()) q = q.ilike('app_user', '%' + pv('rp-user').trim().replace(/[%,()]/g, '') + '%');
      q.then(function(res){
        if(res.error){ rpcErr(res); return; }
        var rows = res.data || [];
        repData = {rows: rows, sum: summarize(rows, d1, d2), filtros: d1 + ' a ' + d2 + (pv('rp-room') ? ' · ' + roomLabelByCode(pv('rp-room')) : '') + (pv('rp-user').trim() ? ' · usuario: ' + pv('rp-user').trim() : '') + (pv('rp-estado') ? ' · estado: ' + pv('rp-estado') : '')};
        var s = repData.sum;
        el('rp-out').innerHTML = rows.length ? '<p><b>' + rows.length + ' reservas</b> · ' + escapeHtml(repData.filtros) + '</p><div class="room-detail-title">Por estado</div>' + tbl(s.estados.map(function(x){ return {Estado: x[0], Cantidad: x[1]}; })) +
          '<div class="room-detail-title">Uso y ocupación por espacio</div>' + tbl(s.uso.slice(0, 15)) + '<div class="room-detail-title">Franjas de mayor demanda</div>' + tbl(s.demanda.slice(0, 5)) +
          '<div class="room-detail-title">Inasistencias</div>' + tbl(s.inasist.slice(0, 10)) + '<div class="room-detail-title">Detalle (primeras 100)</div>' + tbl(rows.slice(0, 100).map(detRow)) : '<div class="content-sub">No hay reservas con esos filtros.</div>';
      });
    });
    el('rp-xls').addEventListener('click', exportXlsx);
    el('rp-pdf').addEventListener('click', exportPdf);
  }
  function exportXlsx(){
    if(!repData.rows.length){ showToast('No hay datos para exportar con esos filtros.'); return; }
    if(typeof XLSX === 'undefined'){ showToast('No se pudo cargar la librería de Excel. Revisa tu conexión.'); return; }
    var wb = XLSX.utils.book_new(), s = repData.sum;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(repData.rows.map(detRow)), 'Detalle');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.uso.length ? s.uso : [{Espacio: '—'}]), 'Uso por espacio');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.demanda.length ? s.demanda : [{Franja: '—'}]), 'Demanda');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.inasist.length ? s.inasist : [{Usuario: '—'}]), 'Inasistencias');
    XLSX.writeFile(wb, 'reporte_uso_' + todayStr() + '.xlsx');
    getSupabase().rpc('log_export', {p_tipo: 'xlsx'});
  }
  function exportPdf(){
    if(!repData.rows.length){ showToast('No hay datos para exportar con esos filtros.'); return; }
    if(!window.jspdf){ showToast('No se pudo cargar la librería de PDF. Revisa tu conexión.'); return; }
    var doc = new window.jspdf.jsPDF({orientation: 'landscape'}), s = repData.sum;
    doc.setFontSize(14); doc.text('Reporte de uso de espacios', 14, 14);
    doc.setFontSize(9); doc.text('Filtros: ' + repData.filtros + ' · Generado: ' + new Date().toLocaleString('es-CO'), 14, 20);
    doc.autoTable({startY: 25, head: [['Espacio', 'Reservas usadas', 'Ocupación %']], body: s.uso.map(function(x){ return [x.Espacio, x['Reservas usadas'], x['Ocupación %']]; })});
    doc.autoTable({startY: doc.lastAutoTable.finalY + 6, head: [['Franja', 'Solicitudes']], body: s.demanda.map(function(x){ return [x.Franja, x.Solicitudes]; })});
    doc.autoTable({startY: doc.lastAutoTable.finalY + 6, head: [['Usuario', 'Inasistencias']], body: s.inasist.map(function(x){ return [x.Usuario, x.Inasistencias]; })});
    doc.addPage();
    doc.autoTable({startY: 14, head: [['Fecha', 'Espacio', 'Horario', 'Usuario', 'Motivo', 'Estado']], body: repData.rows.map(function(r){ return [r.date, roomLabelByCode(r.room), r.slot, r.app_user || '', r.subject || '', r.estado]; })});
    doc.save('reporte_uso_' + todayStr() + '.pdf');
    getSupabase().rpc('log_export', {p_tipo: 'pdf'});
  }

  // RF19 carga masiva desde Excel o CSV
  var BULK = {clases: ['code','block','programa','semestre','asignatura','docente'], espacios: ['code','label','tipo','piso','sillas','ubicacion'], recursos: ['room','tipo','cantidad','operativos','estado']};
  var BULK_REQ = {clases: ['code','block','asignatura'], espacios: ['code','label'], recursos: ['room','tipo']};
  var bulkRows = [];
  function openBulk(){
    bulkRows = [];
    panel('Carga masiva (Excel o CSV)', '<div class="booking-form open">' + sel('bk-tipo', '¿Qué vas a cargar?', [['clases', 'Clases fijas (horario)'], ['espacios', 'Espacios'], ['recursos', 'Recursos / inventario']]) +
      '<div class="row-btns"><button class="btn-primary btn-muted" id="bk-tpl" type="button">Descargar plantilla</button></div><label for="bk-file">Archivo (.xlsx, .xls o .csv)</label><input type="file" id="bk-file" accept=".xlsx,.xls,.csv"></div><div id="bk-out"></div>');
    el('bk-tpl').addEventListener('click', function(){
      if(typeof XLSX === 'undefined'){ showToast('No se pudo cargar la librería de Excel.'); return; }
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([BULK[pv('bk-tipo')]]), 'Plantilla');
      XLSX.writeFile(wb, 'plantilla_' + pv('bk-tipo') + '.xlsx');
    });
    el('bk-file').addEventListener('change', function(e){
      var f = e.target.files[0], out = el('bk-out');
      if(!f) return;
      if(typeof XLSX === 'undefined'){ showToast('No se pudo cargar la librería de Excel.'); return; }
      var rd = new FileReader();
      rd.onload = function(){
        try {
          var wb = XLSX.read(new Uint8Array(rd.result), {type: 'array'}), raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval: ''}), t = pv('bk-tipo');
          bulkRows = raw.map(function(r){ var o = {}; Object.keys(r).forEach(function(k){ o[String(k).trim().toLowerCase()] = String(r[k]).trim(); }); return o; });
          var miss = BULK_REQ[t].filter(function(c){ return !bulkRows.length || !(c in bulkRows[0]); });
          if(!bulkRows.length || miss.length){ bulkRows = []; out.innerHTML = '<p>' + (miss.length ? 'Faltan columnas obligatorias: <b>' + miss.join(', ') + '</b>. Descarga la plantilla.' : 'El archivo no tiene filas.') + '</p>'; return; }
          if(bulkRows.length > 2000){ bulkRows = []; out.innerHTML = '<p>El archivo supera las 2000 filas.</p>'; return; }
          out.innerHTML = '<p><b>' + bulkRows.length + ' filas</b> leídas. Vista previa:</p>' + tbl(bulkRows.slice(0, 5)) + '<div class="row-btns" style="margin-top:10px;"><button class="btn-primary btn-confirm" id="bk-go" type="button">Importar</button></div>';
          el('bk-go').addEventListener('click', function(){
            rpcDo('bulk_import', {p_tipo: t, p_rows: bulkRows}, null, function(r){
              out.innerHTML = '<p><b>Importadas: ' + r.importadas + '</b> · Con error: ' + r.errores.length + '</p>' + r.errores.slice(0, 50).map(function(x){ return '<div class="slot-state">Fila ' + x.fila + ': ' + escapeHtml(x.motivo) + '</div>'; }).join('');
              reload().then(function(){ renderRooms(); });
            });
          });
        } catch(err){ out.innerHTML = '<p>No se pudo leer el archivo. Usa .xlsx o .csv con la plantilla.</p>'; }
      };
      rd.readAsArrayBuffer(f);
    });
  }
  ['notif-btn','coord-notif-btn'].forEach(function(id){ el(id).addEventListener('click', openNotifs); });
  ['cal-btn','coord-cal-btn'].forEach(function(id){ el(id).addEventListener('click', function(){ openCalendar(); }); });
  el('coord-rep-btn').addEventListener('click', openReports);
  el('coord-bulk-btn').addEventListener('click', openBulk);

  // ---------- LÍMITES DE RESERVA (RF32, coordinador) ----------
  var RULE_KEYS = ['max_dia_estudiante','max_activas_estudiante','max_dia_docente','max_activas_docente'];
  el('coord-rules-btn').addEventListener('click', function(){
    getSupabase().from('reglas').select('*').then(function(res){
      (res.data || []).forEach(function(r){ var i = el('rg-' + r.clave); if(i) i.value = r.valor; });
      el('rules-backdrop').style.display = 'flex';
    });
  });
  el('rules-close').addEventListener('click', function(){ el('rules-backdrop').style.display = 'none'; });
  el('rules-cancel').addEventListener('click', function(){ el('rules-backdrop').style.display = 'none'; });
  el('rules-save').addEventListener('click', function(){
    var vals = RULE_KEYS.map(function(k){ return {k: k, v: parseInt(el('rg-' + k).value, 10)}; });
    if(vals.some(function(x){ return !(x.v >= 1); })){ showToast('Todos los límites deben ser números de 1 o más.'); return; }
    Promise.all(vals.map(function(x){ return getSupabase().from('reglas').update({valor: x.v}).eq('clave', x.k); })).then(function(rs){
      var bad = rs.filter(function(r){ return r.error; })[0];
      if(bad){ rpcErr(bad); return; }
      el('rules-backdrop').style.display = 'none';
      showToast('Límites actualizados.');
    });
  });

  // ---------- USUARIOS (administrador, RF30) ----------
  var editingUser = null;
  function openUserForm(u){
    editingUser = u;
    el('ue-title').textContent = u ? 'Editar usuario' : 'Crear cuenta';
    el('ue-nombre').value = u ? u.nombre : '';
    el('ue-doc').value = u ? (u.documento || '') : '';
    el('ue-email').value = u ? u.email : '';
    el('ue-email').disabled = !!u;
    el('ue-pass').value = '';
    el('ue-passrow').style.display = u ? 'none' : '';
    el('ue-rol').innerHTML = ['estudiante','docente','coordinador','administrador','mantenimiento'].map(function(r){ return '<option' + (u && u.rol === r ? ' selected' : '') + '>' + r + '</option>'; }).join('');
    el('uedit-backdrop').style.display = 'flex';
  }
  function closeUserForm(){ el('uedit-backdrop').style.display = 'none'; }
  el('users-new-btn').addEventListener('click', function(){ openUserForm(null); });
  el('ue-close').addEventListener('click', closeUserForm);
  el('ue-cancel').addEventListener('click', closeUserForm);
  function userDone(){ closeUserForm(); showToast('Usuario guardado.'); renderUsers(); }
  el('ue-save').addEventListener('click', function(){
    var sb = getSupabase(), nombre = el('ue-nombre').value.trim(), doc = el('ue-doc').value.trim(), rol = el('ue-rol').value;
    if(nombre.length < 3){ showToast('Escribe el nombre completo.'); return; }
    if(!/^\d{5,15}$/.test(doc)){ showToast('El documento debe tener solo dígitos (5 a 15).'); return; }
    function setRol(id, actual){
      if(rol === actual) return Promise.resolve({});
      return sb.rpc('admin_set_rol', {p_user: id, p_rol: rol});
    }
    if(editingUser){
      sb.rpc('admin_update_user', {p_user: editingUser.id, p_nombre: nombre, p_documento: doc}).then(function(r){
        if(r.error){ rpcErr(r); return; }
        return setRol(editingUser.id, editingUser.rol).then(function(r2){ if(r2.error){ rpcErr(r2); return; } userDone(); });
      });
      return;
    }
    var email = el('ue-email').value.trim().toLowerCase(), pass = el('ue-pass').value;
    if(!email){ showToast('Escribe el correo.'); return; }
    if(!passwordOk(pass)){ showToast('La contraseña inicial debe tener 8+ caracteres, con letras y números.'); return; }
    // Cliente aparte sin sesión persistente: crear la cuenta no cierra la sesión del administrador.
    var tmp = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}});
    tmp.auth.signUp({email: email, password: pass, options: {data: {nombre: nombre, documento: doc, rol: rol === 'docente' ? 'docente' : 'estudiante'}}}).then(function(res){
      var u = res.data && res.data.user;
      if(res.error || !u || (u.identities && u.identities.length === 0)){ showToast(res.error ? 'No se pudo crear: ' + res.error.message : 'Ya existe una cuenta con ese correo.'); return; }
      return setRol(u.id, rol === 'docente' ? 'docente' : 'estudiante').then(function(r2){ if(r2.error){ rpcErr(r2); return; } userDone(); });
    });
  });
  var ROLES = ['estudiante','docente','coordinador','administrador','mantenimiento'];
  el('coord-users-btn').addEventListener('click', function(){ el('users-backdrop').style.display = 'flex'; renderUsers(); });
  el('users-close').addEventListener('click', function(){ el('users-backdrop').style.display = 'none'; });
  function renderUsers(){
    getSupabase().from('profiles').select('*').order('nombre').then(function(res){
      var list = el('users-list');
      list.innerHTML = '';
      (res.data || []).forEach(function(u){
        var row = document.createElement('div');
        row.className = 'slot-row';
        row.innerHTML = '<div><div class="slot-time">' + escapeHtml(u.nombre) + (u.activo ? '' : ' (inactivo)') + '</div><span class="slot-state">' + escapeHtml(u.email) + ' · Doc. ' + escapeHtml(u.documento || '') + '</span></div>' +
          '<div class="row-btns" style="flex:0 0 auto;"><select class="u-rol">' + ROLES.map(function(r){ return '<option' + (r === u.rol ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>' +
          '<button class="slot-btn book u-edit" type="button">Editar</button><button class="slot-btn ' + (u.activo ? 'cancel' : 'book') + ' u-act" type="button">' + (u.activo ? 'Desactivar' : 'Activar') + '</button></div>';
        row.querySelector('.u-edit').addEventListener('click', function(){ openUserForm(u); });
        row.querySelector('.u-rol').addEventListener('change', function(e){
          getSupabase().rpc('admin_set_rol', {p_user: u.id, p_rol: e.target.value}).then(function(r){ if(r.error) rpcErr(r); else showToast('Rol actualizado.'); renderUsers(); });
        });
        row.querySelector('.u-act').addEventListener('click', function(){
          if(u.activo && !confirm('Se cancelarán sus reservas futuras y se liberarán los espacios. ¿Continuar?')) return;
          getSupabase().rpc('admin_set_active', {p_user: u.id, p_activo: !u.activo}).then(function(r){ if(r.error) rpcErr(r); else showToast('Cuenta actualizada.'); renderUsers(); });
        });
        list.appendChild(row);
      });
    });
  }

  // ---------- FILTERS ----------
  document.querySelectorAll('[data-franja]').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('[data-franja]').forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      state.franja = btn.getAttribute('data-franja');
      updateHeadings();
      renderRooms();
    });
  });
  document.querySelectorAll('[data-piso]').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('[data-piso]').forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      state.piso = btn.getAttribute('data-piso');
      renderRooms();
    });
  });
  document.getElementById('date-picker').addEventListener('change', function(e){
    state.date = e.target.value || todayStr();
    loadBookingsForDate(state.date).then(function(list){
      state.bookings = list;
      renderRooms();
    });
  });

  // ---------- PANEL COORDINADOR (editar horario fijo) ----------
  var BLOCK_LABELS = {'8-10':'8:00–10:00','10-12':'10:00–12:00','18-20':'18:00–20:00','20-22':'20:00–22:00'};
  var coordEditingId = null;

  function openCoordPanel(){
    document.getElementById('coordinador-screen').style.display = 'block';
    loadCoordTable();
  }

  document.getElementById('coord-logout-btn').addEventListener('click', function(){
    doLogout();
    showAuthView('login-form');
    document.getElementById('coordinador-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('login-user').value = '';
    document.getElementById('login-pass').value = '';
  });

  function loadCoordTable(){
    var sb = getSupabase();
    if(!sb) return;
    sb.from('horario_fijo').select('*').order('code').order('block').then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo cargar el horario.');
        return;
      }
      renderCoordTable(res.data || []);
    });
  }

  function renderCoordTable(rows){
    var body = document.getElementById('coord-table-body');
    body.innerHTML = '';
    rows.forEach(function(r){
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(r.code) + '</td>' +
        '<td>' + (BLOCK_LABELS[r.block] || escapeHtml(r.block)) + '</td>' +
        '<td>' + escapeHtml(r.jornada || '') + '</td>' +
        '<td>' + escapeHtml(r.programa || '') + '</td>' +
        '<td>' + escapeHtml(r.semestre || '') + '</td>' +
        '<td>' + escapeHtml(r.asignatura || '') + '</td>' +
        '<td>' + escapeHtml(r.docente || '') + '</td>' +
        '<td class="coord-actions">' +
          '<button class="btn-ghost coord-move-class" data-id="' + r.id + '" type="button">Cambiar salón</button>' +
          '<button class="btn-ghost coord-edit" data-id="' + r.id + '" type="button">Editar</button>' +
          '<button class="btn-ghost coord-delete" data-id="' + r.id + '" type="button">Borrar</button>' +
        '</td>';
      body.appendChild(tr);
    });
    body.querySelectorAll('.coord-move-class').forEach(function(btn){
      btn.addEventListener('click', function(){ openRoomChange('class', Number(btn.getAttribute('data-id'))); });
    });
    body.querySelectorAll('.coord-edit').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = Number(btn.getAttribute('data-id'));
        var row = rows.filter(function(r){ return r.id === id; })[0];
        if(row) openCoordModal(row);
      });
    });
    body.querySelectorAll('.coord-delete').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = Number(btn.getAttribute('data-id'));
        if(!confirm('¿Borrar esta clase del horario?')) return;
        getSupabase().from('horario_fijo').delete().eq('id', id).then(function(res){
          if(res.error){
            console.error(res.error);
            showToast('No se pudo borrar.');
            return;
          }
          showToast('Clase eliminada.');
          loadCoordTable();
          staticDataPromise = loadStaticData();
        });
      });
    });
  }

  function openCoordModal(row){
    coordEditingId = row ? row.id : null;
    document.getElementById('coord-modal-title').textContent = row ? 'Editar clase' : 'Nueva clase';
    document.getElementById('coord-code').value = row ? row.code : '';
    document.getElementById('coord-block').value = row ? row.block : '8-10';
    document.getElementById('coord-jornada').value = row ? (row.jornada || '') : '';
    document.getElementById('coord-programa').value = row ? (row.programa || '') : '';
    document.getElementById('coord-semestre').value = row ? (row.semestre || '') : '';
    document.getElementById('coord-asignatura').value = row ? (row.asignatura || '') : '';
    document.getElementById('coord-docente').value = row ? (row.docente || '') : '';
    document.getElementById('coord-modal-backdrop').style.display = 'flex';
  }
  function closeCoordModal(){
    document.getElementById('coord-modal-backdrop').style.display = 'none';
    coordEditingId = null;
  }
  document.getElementById('coord-new-btn').addEventListener('click', function(){ openCoordModal(null); });
  document.getElementById('coord-modal-close').addEventListener('click', closeCoordModal);
  document.getElementById('coord-cancel-btn').addEventListener('click', closeCoordModal);
  document.getElementById('coord-modal-backdrop').addEventListener('click', function(e){
    if(e.target === document.getElementById('coord-modal-backdrop')) closeCoordModal();
  });

  document.getElementById('coord-save-btn').addEventListener('click', function(){
    var payload = {
      code: document.getElementById('coord-code').value.trim(),
      block: document.getElementById('coord-block').value,
      jornada: document.getElementById('coord-jornada').value.trim(),
      programa: document.getElementById('coord-programa').value.trim(),
      semestre: document.getElementById('coord-semestre').value.trim(),
      asignatura: document.getElementById('coord-asignatura').value.trim(),
      docente: document.getElementById('coord-docente').value.trim()
    };
    if(!payload.code){
      showToast('Escribe el código del salón.');
      return;
    }
    var sb = getSupabase();
    if(!sb) return;
    var req = coordEditingId
      ? sb.from('horario_fijo').update(payload).eq('id', coordEditingId)
      : sb.from('horario_fijo').insert(payload);
    req.then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo guardar.');
        return;
      }
      showToast('Guardado.');
      closeCoordModal();
      loadCoordTable();
      staticDataPromise = loadStaticData();
    });
  });

  // ---------- TODAS LAS RESERVAS (vista del coordinador) ----------
  var allBookingsBackdrop = document.getElementById('allbookings-backdrop');

  function getAllBookingsAdmin(){
    var sb = getSupabase();
    if(!sb) return Promise.resolve([]);
    return sb.from('bookings').select('*').order('date', {ascending:true}).order('slot', {ascending:true}).then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo consultar la base de datos.');
        return [];
      }
      return (res.data || []).map(rowToBooking);
    });
  }

  function openAllBookingsModal(){
    allBookingsBackdrop.style.display = 'flex';
    document.getElementById('allbookings-empty').style.display = 'none';
    document.getElementById('allbookings-list').innerHTML = '<div class="content-sub">Cargando...</div>';
    releaseNoShows().then(renderAllBookings);
  }
  function closeAllBookingsModal(){
    allBookingsBackdrop.style.display = 'none';
  }
  document.getElementById('coord-reservas-btn').addEventListener('click', openAllBookingsModal);
  document.getElementById('allbookings-close').addEventListener('click', closeAllBookingsModal);
  allBookingsBackdrop.addEventListener('click', function(e){ if(e.target === allBookingsBackdrop) closeAllBookingsModal(); });

  function renderAllBookings(){
    getAllBookingsAdmin().then(function(all){
      var list = document.getElementById('allbookings-list');
      var empty = document.getElementById('allbookings-empty');
      list.innerHTML = '';
      if(all.length === 0){
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      all.forEach(function(b){
        var row = document.createElement('div');
        row.className = 'slot-row';
        row.innerHTML =
          '<div>' +
            '<div class="slot-time">' + roomLabelByCode(b.room) + ' · ' + b.date + ' · ' + b.slot + '</div>' +
            '<span class="slot-state">Agendó: ' + escapeHtml(b.user) + ' · Doc. ' + escapeHtml(b.documento || '') + ' · ' + escapeHtml(b.subject || '') + ' · ' + estadoText(b) + '</span>' +
          '</div>' +
          '<div class="row-btns" style="flex:0 0 auto;">' +
            (b.estado === 'pendiente' ? '<button class="slot-btn book coord-confirm" data-id="' + b.id + '" type="button">Confirmar</button><button class="slot-btn cancel coord-reject" data-id="' + b.id + '" type="button">Rechazar</button>' : '') +
            (isActive(b) ? '<button class="slot-btn book coord-move" data-id="' + b.id + '" type="button">Cambiar salón</button><button class="slot-btn cancel coord-cancel-booking" data-id="' + b.id + '" type="button">Cancelar</button>' : '') +
          '</div>';
        list.appendChild(row);
      });
      list.querySelectorAll('.coord-confirm').forEach(function(btn){
        btn.addEventListener('click', function(){
          var id = btn.getAttribute('data-id');
          getSupabase().rpc('decide_booking', {p_id: Number(id), p_decision: 'confirmada', p_motivo: null}).then(function(res){
            if(res.error){ rpcErr(res); return; }
            showToast('Reserva confirmada.');
            renderAllBookings();
          });
        });
      });
      list.querySelectorAll('.coord-move').forEach(function(btn){
        btn.addEventListener('click', function(){ openRoomChange('booking', Number(btn.getAttribute('data-id'))); });
      });
      list.querySelectorAll('.coord-reject').forEach(function(btn){
        btn.addEventListener('click', function(){
          rejectingId = btn.getAttribute('data-id');
          el('rej-motivo').value = '';
          el('reject-backdrop').style.display = 'flex';
        });
      });
      list.querySelectorAll('.coord-cancel-booking').forEach(function(btn){
        btn.addEventListener('click', function(){
          var id = btn.getAttribute('data-id');
          if(!confirm('¿Cancelar esta reserva?')) return;
          deleteBookingById(id).then(function(ok){ if(!ok) return;
            showToast('Reserva cancelada.');
            renderAllBookings();
          });
        });
      });
    });
  }

  function updateHeadings(){
    var title = document.getElementById('content-title');
    var sub = document.getElementById('content-sub');
    var note = document.getElementById('franja-note');
    if(state.franja === 'manana'){
      title.textContent = 'Consultar clases fijas';
      sub.textContent = 'Estado de los salones en los bloques fijos: 8:00–10:00, 10:00–12:00, 18:00–20:00 y 20:00–22:00.';
      note.textContent = 'Las clases fijas de la universidad son de 8:00 a 12:00 y de 18:00 a 22:00 (bloques de 2 horas). Esta vista es de consulta; igual puedes hacer click en un salón para agendarlo en el horario libre.';
    } else {
      title.textContent = 'Agendar salón';
      sub.textContent = 'Elige un salón, luego una fecha en el calendario y una hora entre 12:00 y 18:00 (18:00–22:00 para laboratorios).';
      note.textContent = 'El único horario libre para agendar salones normales es de 12:00 a 18:00, porque de 8 a 12 y de 18 a 22 hay clases fijas. Los laboratorios se agendan solo de 18:00 a 22:00.';
    }
  }

  // ---------- BASE DE DATOS (Supabase / Postgres) ----------
  function getSupabase(){
    if(typeof supabaseClient === 'undefined' || !supabaseClient){
      showToast('Falta configurar Supabase en supabase-config.js');
      return null;
    }
    return supabaseClient;
  }

  function loadBookingsForDate(dateStr){
    var sb = getSupabase();
    if(!sb) return Promise.resolve([]);
    return sb.from('bookings_ocupacion').select('*').eq('date', dateStr).in('estado',['pendiente','confirmada']).then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo conectar con la base de datos.');
        return [];
      }
      return (res.data || []).map(rowToBooking);
    });
  }

  var lastErr = '';
  function rpcErr(res){ lastErr = (res.error && res.error.message) || ''; showToast(lastErr || 'No se pudo completar la acción.'); }
  function insertBooking(dateStr, booking){
    var sb = getSupabase();
    if(!sb) return Promise.resolve(null);
    return sb.rpc('create_booking', {p_room: booking.room, p_date: dateStr, p_slot: booking.slot, p_doc: booking.documento, p_subject: booking.subject, p_asistentes: booking.asistentes}).then(function(res){
      if(res.error){ rpcErr(res); return null; }
      return rowToBooking(res.data);
    });
  }
  function deleteBookingById(id){
    var sb = getSupabase();
    if(!sb) return Promise.resolve(false);
    return sb.rpc('cancel_booking', {p_id: Number(id)}).then(function(res){
      if(res.error){ rpcErr(res); return false; }
      return true;
    });
  }
  function estadoText(b){
    var m = {pendiente:'Pendiente de confirmar', confirmada:'Confirmada ✓', rechazada:'Rechazada', cancelada:'Cancelada', no_asistio:'No asistió (liberada)', finalizada:'Finalizada', finalizada_sin_registro:'Finalizada sin registro'};
    return (m[b.estado] || b.estado) + (b.estado === 'rechazada' && b.motivo_rechazo ? ' (' + escapeHtml(b.motivo_rechazo) + ')' : '');
  }
  function isActive(b){ return b.estado === 'pendiente' || b.estado === 'confirmada'; }

  // ---------- CORREO AL COORDINADOR (EmailJS) ----------
  function baseUrl(){
    // Construye la URL de la página actual sin el "index.html" del final,
    // para que el link de confirmación apunte a confirmar.html en el mismo sitio.
    return window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
  }

  function notifyCoordinator(booking, room){
    if(typeof emailjs === 'undefined' || typeof EMAILJS_SERVICE_ID === 'undefined'){
      console.warn('EmailJS no está configurado (revisa email-config.js). No se envió el correo.');
      return;
    }
    var confirmLink = baseUrl() + 'confirmar.html?id=' + booking.id + '&token=' + booking.confirm_token;
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      sala: room.label,
      fecha: booking.date,
      hora: booking.slot,
      usuario: booking.user,
      documento: booking.documento || '',
      materia: booking.subject || '',
      confirm_link: confirmLink
    }).catch(function(err){
      console.error('Error enviando correo al coordinador:', err);
    });
  }

  function rowToBooking(r){
    return {id:r.id, room:r.room, slot:r.slot, user:r.app_user, documento:r.documento, subject:r.subject, date:r.date, mine: (r.mine !== undefined ? r.mine : !!(state.profile && r.user_id === state.profile.id)), checkin_at:r.checkin_at, estado:r.estado, motivo_rechazo:r.motivo_rechazo, asistentes:r.asistentes, confirm_token:r.confirm_token};
  }

  function slotsForRoom(room){
    return room.tipo === 'lab' ? LAB_ONLY_SLOTS : SLOTS_TARDE;
  }

  // Texto corto de tipo/piso para las tarjetas y el modal
  function roomTypeLabel(room){
    if(room.tipo === 'lab') return 'Laboratorio';
    if(room.tipo === 'especial') return 'Sala especial · Piso ' + room.piso;
    return 'Piso ' + room.piso;
  }

  // Resumen corto para la tarjeta de la grilla (aula/especial: sillas y equipo; lab: ubicación)
  function roomCardMeta(room){
    var bl = blockFor(room, state.date), t = el('f-recurso').value, extra = '';
    if(t) extra = ' · ' + escapeHtml(t) + ': ' + recursosOf(room.code).filter(function(x){ return x.tipo === t && x.estado === 'operativo'; }).reduce(function(s, x){ return s + x.operativos; }, 0) + ' operativos';
    return (bl ? 'Bloqueado: ' + escapeHtml(bl.motivo || bl.tipo) + ' · ' : '') + roomCardMeta0(room) + extra;
  }
  function roomCardMeta0(room){
    if(room.tipo === 'lab' || room.tipo === 'especial'){
      var bits = [];
      if(room.equipo) bits.push(room.equipo);
      if(room.ubicacion) bits.push(room.ubicacion);
      return bits.join(' · ') || 'Ver información completa';
    }
    if(room.sillas === undefined) return room.nota || 'Sin datos de inventario';
    return room.sillas + ' sillas · ' + room.equipo;
  }

  function bookingFor(list, room, slot){
    for(var i=0;i<list.length;i++){
      var b = list[i];
      if(b.room === room.code && b.slot === slot) return b;
    }
    return null;
  }

  // ---------- RENDER ROOM GRID ----------
  function filteredRooms(){
    var q = el('f-search').value.trim().toLowerCase(), t = el('f-recurso').value, mn = parseInt(el('f-min').value, 10) || 1, af = parseInt(el('f-aforo').value, 10) || 0;
    return filteredRooms0().filter(function(r){
      if(q && (r.code + ' ' + r.label).toLowerCase().indexOf(q) < 0) return false;
      if(af && !(r.sillas >= af)) return false;
      if(el('f-ok').checked && blockFor(r, state.date)) return false;
      if(t){
        var n = recursosOf(r.code).filter(function(x){ return x.tipo === t && x.estado === 'operativo'; }).reduce(function(s, x){ return s + x.operativos; }, 0);
        if(n < mn) return false;
      }
      return true;
    });
  }
  function filteredRooms0(){
    return ROOMS.filter(function(r){
      if(state.piso === 'todos') return true;
      if(state.piso === 'lab') return r.tipo === 'lab';
      if(state.piso === 'especial') return r.tipo === 'especial';
      return String(r.piso) === state.piso && r.tipo === 'aula';
    });
  }

  function renderRooms(){
    syncRecursoOptions();
    var grid = document.getElementById('room-grid');
    var empty = document.getElementById('empty-state');
    grid.innerHTML = '';
    var rooms = filteredRooms();
    if(rooms.length === 0){
      empty.textContent = (el('f-search').value || el('f-recurso').value || el('f-min').value || el('f-aforo').value || el('f-ok').checked) ? 'Ningún espacio cumple todos los filtros. Prueba retirar alguno.' : 'No hay salones para este filtro.';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    rooms.forEach(function(room){
      var card = document.createElement('div');
      card.className = 'room-card';
      card.tabIndex = 0;

      var tab = document.createElement('div');
      var body = document.createElement('div');
      body.className = 'room-body';

      if(state.franja === 'manana'){
        var fixedBlocks = room.tipo === 'lab' ? [] : MORNING_BLOCKS.concat(EVENING_BLOCKS);
        var occStates = fixedBlocks.map(function(b){
          return blockOccupied(room, state.date, b.key);
        });
        var anyOcc = occStates.some(function(v){return v;});
        var allOcc = fixedBlocks.length > 0 && occStates.every(function(v){return v;});
        var cls = allOcc ? 'occupied' : (anyOcc ? 'mixed' : 'available');
        tab.className = 'placard-tab ' + cls;
        var statusText = allOcc ? 'Ocupado en clases fijas' : (anyOcc ? 'Ocupado en parte del día' : 'Sin clases fijas');
        body.innerHTML =
          '<div class="room-code mono">' + room.label + '</div>' +
          '<div class="room-type">' + roomTypeLabel(room) + '</div>' +
          '<div class="room-status ' + (allOcc ? 'occupied' : (anyOcc ? 'mixed' : 'available')) + '">' + statusText + '</div>' +
          '<div class="room-meta">' + roomCardMeta(room) + '</div>';
        card.addEventListener('click', function(){ openInfoModal(room); });
        card.addEventListener('keypress', function(e){ if(e.key === 'Enter') openInfoModal(room); });
      } else {
        var slots = slotsForRoom(room);
        var freeCount = 0, mineCount = 0;
        slots.forEach(function(s){
          var b = bookingFor(state.bookings, room, s);
          if(!b) freeCount++;
          else if(b.mine) mineCount++;
        });
        var allBusy = freeCount === 0;
        var stateClass = mineCount > 0 ? 'mixed' : (allBusy ? 'occupied' : 'available');
        tab.className = 'placard-tab ' + stateClass;
        var statusText2 = mineCount > 0
          ? mineCount + ' bloque(s) tuyos'
          : (allBusy ? 'Sin bloques libres' : freeCount + ' bloques libres');
        body.innerHTML =
          '<div class="room-code mono">' + room.label + '</div>' +
          '<div class="room-type">' + (room.tipo === 'lab' ? 'Laboratorio · noche' : roomTypeLabel(room)) + '</div>' +
          '<div class="room-status ' + stateClass + '">' + statusText2 + '</div>' +
          '<div class="room-meta">' + roomCardMeta(room) + '</div>';
        card.addEventListener('click', function(){ openCalendarModal(room); });
        card.addEventListener('keypress', function(e){ if(e.key === 'Enter') openCalendarModal(room); });
      }

      tab.classList.add('placard-tab');
      card.appendChild(tab);
      card.appendChild(body);
      grid.appendChild(card);
    });
  }

  // ---------- MODAL: shared ----------
  var backdrop = document.getElementById('modal-backdrop');
  var activeRoom = null;
  var pendingSlot = null;

  var sectionInfo = document.getElementById('modal-info');
  var sectionCalendar = document.getElementById('modal-calendar');
  var sectionSlots = document.getElementById('modal-slots');

  function showSection(section){
    [sectionInfo, sectionCalendar, sectionSlots].forEach(function(s){ s.classList.remove('open'); });
    section.classList.add('open');
  }

  function closeModal(){
    backdrop.style.display = 'none';
    activeRoom = null;
    pendingSlot = null;
  }
  document.getElementById('modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', function(e){ if(e.target === backdrop) closeModal(); });

  // ---------- FICHA COMPLETA DEL SALÓN (datos tal cual del Formato Informe de Sede 2) ----------
  function renderRoomDetail(room){
    var box = document.getElementById('room-detail');
    if(!box) return;
    var rows = [];
    rows.push(['Ubicación', room.ubicacion || roomTypeLabel(room)]);
    if(room.sillas !== undefined) rows.push(['No. de sillas', String(room.sillas)]);
    if(room.equipo) rows.push(['Tv-cámara-PC', room.equipo]);
    if(room.videoBeam !== undefined) rows.push(['Video beam', room.videoBeam === 1 ? 'Sí tiene' : 'No tiene']);
    if(room.metraje) rows.push(['Metraje', room.metraje]);
    if(room.nota) rows.push(['Nota', room.nota]);

    var rs = recursosOf(room.code);
    if(rs.length) rows.push(['Recursos', rs.map(function(r){ return escapeHtml(r.tipo) + ' ×' + r.cantidad + ' (' + r.operativos + ' operativos)'; }).join(', ')]);
    box.innerHTML = '<div class="room-detail-title">Información del salón</div>' +
      '<div class="room-detail-grid">' +
      rows.map(function(r){
        return '<div class="room-detail-item">' +
          '<div class="room-detail-label">' + r[0] + '</div>' +
          '<div class="room-detail-value">' + r[1] + '</div>' +
          '</div>';
      }).join('') +
      '</div>';
  }

  // ---------- MODAL: info (horario fijo de clases, solo lectura) ----------
  function openInfoModal(room){
    activeRoom = room;
    document.getElementById('modal-room-title').textContent = room.label;
    document.getElementById('modal-sub').textContent = 'Horario fijo de clases (Lunes a Viernes) · Espacio libre para agendar: 12:00–18:00';
    renderRoomDetail(room);
    var list = document.getElementById('block-info-list');
    list.innerHTML = '';
    var fixedBlocks = room.tipo === 'lab' ? [] : MORNING_BLOCKS.concat(EVENING_BLOCKS);
    fixedBlocks.forEach(function(b){
      var occ = blockOccupied(room, state.date, b.key);
      var row = document.createElement('div');
      row.className = 'block-info-row';
      row.innerHTML =
        '<div><div class="block-info-time">' + b.label + '</div>' +
        (occ ? '<div class="block-info-subject">' + blockSubject(room, state.date, b.key) + '</div>' : '') +
        '</div>' +
        '<div class="block-info-status ' + (occ ? 'occupied' : 'available') + '">' + (occ ? 'Ocupado' : 'Disponible') + '</div>';
      list.appendChild(row);
    });
    if(fixedBlocks.length === 0){
      var empty = document.createElement('div');
      empty.className = 'block-info-row';
      empty.innerHTML = '<div class="block-info-time">Sin horario fijo registrado para este espacio</div>';
      list.appendChild(empty);
    }
    var goBtn = document.getElementById('info-go-agendar');
    if(goBtn){
      goBtn.onclick = function(){ openCalendarModal(room); };
    }
    showSection(sectionInfo);
    backdrop.style.display = 'flex';
  }

  // ---------- MODAL: calendar (paso 1 para agendar) ----------
  function openCalendarModal(room){
    activeRoom = room;
    document.getElementById('modal-room-title').textContent = room.label;
    document.getElementById('modal-sub').textContent = (room.tipo === 'lab' ? 'Bloque nocturno agendable: 18:00–22:00' : 'Bloque agendable: 12:00 a 18:00') + ' · elige una fecha';
    renderRoomDetail(room);
    var start = parseDateStr(todayStr());
    state.calMonth = {year: start.getFullYear(), month: start.getMonth()};
    renderCalendar();
    showSection(sectionCalendar);
    backdrop.style.display = 'flex';
  }

  document.getElementById('cal-prev').addEventListener('click', function(){
    shiftCalMonth(-1);
  });
  document.getElementById('cal-next').addEventListener('click', function(){
    shiftCalMonth(1);
  });
  function shiftCalMonth(delta){
    var m = state.calMonth.month + delta;
    var y = state.calMonth.year;
    if(m < 0){ m = 11; y--; }
    if(m > 11){ m = 0; y++; }
    state.calMonth = {year:y, month:m};
    renderCalendar();
  }

  function renderCalendar(){
    var year = state.calMonth.year, month = state.calMonth.month;
    var monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    document.getElementById('cal-month-label').textContent = monthNames[month] + ' ' + year;

    var today = parseDateStr(todayStr());
    var end = parseDateStr(moduleEndStr());
    var firstOfMonth = new Date(year, month, 1);
    var startWeekday = firstOfMonth.getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();

    var grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';

    for(var i=0;i<startWeekday;i++){
      var empty = document.createElement('div');
      empty.className = 'cal-day empty';
      grid.appendChild(empty);
    }

    for(var d=1; d<=daysInMonth; d++){
      var cellDate = new Date(year, month, d);
      var cellStr = todayStr(cellDate);
      var cell = document.createElement('div');
      cell.className = 'cal-day';
      cell.textContent = d;

      var inRange = cellDate >= stripTime(today) && cellDate <= stripTime(end);
      if(cellStr === todayStr()) cell.classList.add('today');

      if(!inRange){
        cell.classList.add('disabled');
      } else {
        cell.addEventListener('click', function(dateStr){
          return function(){ selectCalendarDate(dateStr); };
        }(cellStr));
      }
      grid.appendChild(cell);
    }

    document.getElementById('cal-prev').disabled = (year === today.getFullYear() && month === today.getMonth());
    document.getElementById('cal-next').disabled = (year === end.getFullYear() && month === end.getMonth());
  }
  function stripTime(d){
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function selectCalendarDate(dateStr){
    state.calDate = dateStr;
    loadBookingsForDate(dateStr).then(function(list){
      openSlotsView(dateStr, list);
    });
  }

  // ---------- MODAL: slots (paso 2, elegir hora) ----------
  var slotsListBookings = [];

  function openSlotsView(dateStr, list){
    slotsListBookings = list;
    document.getElementById('modal-sub').textContent = 'Fecha: ' + dateStr + (activeRoom.tipo === 'lab' ? ' · Bloque nocturno 18:00–22:00' : ' · Bloque 12:00–18:00');
    renderSlotList();
    closeBookingForm();
    showSection(sectionSlots);
  }

  document.getElementById('back-to-calendar').addEventListener('click', function(){
    showSection(sectionCalendar);
  });

  function renderSlotList(){
    var list = document.getElementById('slot-list');
    list.innerHTML = '';
    var slots = slotsForRoom(activeRoom);
    slots.forEach(function(slot){
      var b = bookingFor(slotsListBookings, activeRoom, slot);
      var row = document.createElement('div');
      row.className = 'slot-row';
      var timeEl = '<span class="slot-time">' + slot + '</span>';
      var right;
      if(!b && blockedAt(activeRoom, state.calDate, slot)){
        row.classList.add('locked');
        right = '<span class="slot-state">Bloqueado</span> <button class="slot-btn disabled" disabled>Bloqueado</button>';
      } else if(!b){
        right = '<button class="slot-btn book" data-slot="' + slot + '">Agendar</button>';
      } else if(b.mine){
        right = '<span class="slot-state">Tu reserva · ' + estadoText(b) + '</span> <button class="slot-btn cancel" data-slot="' + slot + '">Cancelar</button>';
      } else {
        row.classList.add('locked');
        right = '<span class="slot-state">Reservado</span> <button class="slot-btn disabled" disabled>Ocupado</button> <button class="slot-btn alertme" data-slot="' + slot + '" type="button">Avisarme</button>';
      }
      row.innerHTML = timeEl + '<span style="display:flex;align-items:center;gap:8px;">' + right + '</span>';
      list.appendChild(row);
    });

    list.querySelectorAll('.slot-btn.alertme').forEach(function(btn){
      btn.addEventListener('click', function(){ createAlert(activeRoom.code, state.calDate, btn.getAttribute('data-slot')); });
    });
    list.querySelectorAll('.slot-btn.book').forEach(function(btn){
      btn.addEventListener('click', function(){
        pendingSlot = btn.getAttribute('data-slot');
        openBookingForm();
      });
    });
    list.querySelectorAll('.slot-btn.cancel').forEach(function(btn){
      btn.addEventListener('click', function(){
        var slot = btn.getAttribute('data-slot');
        cancelBooking(slot);
      });
    });
  }

  function openBookingForm(){
    document.getElementById('booking-form').classList.add('open');
    document.getElementById('booking-doc').value = (state.profile && state.profile.documento) || '';
    document.getElementById('booking-subject').value = '';
    document.getElementById('booking-asist').value = '';
    el('booking-rep').checked = false;
    el('rep-row').style.display = (state.profile && state.profile.rol !== 'estudiante') ? '' : 'none';
    document.getElementById('booking-doc').focus();
  }
  function closeBookingForm(){
    document.getElementById('booking-form').classList.remove('open');
    pendingSlot = null;
  }
  document.getElementById('cancel-form').addEventListener('click', closeBookingForm);

  document.getElementById('confirm-booking').addEventListener('click', function(){
    var documento = document.getElementById('booking-doc').value.trim();
    var subject = document.getElementById('booking-subject').value.trim();
    if(!documento){
      showToast('Ingresa el documento de identidad.');
      return;
    }
    if(!subject){
      showToast('Escribe un motivo o materia para reservar.');
      return;
    }
    var asistentes = parseInt(document.getElementById('booking-asist').value, 10);
    if(!(asistentes >= 1)){ showToast('Indica la cantidad de asistentes.'); return; }
    if(el('booking-rep').checked){ createSeries(documento, subject, asistentes); return; }
    insertBooking(state.calDate, {room: activeRoom.code, slot: pendingSlot, user: state.user, documento: documento, subject: subject, asistentes: asistentes}).then(function(newBooking){
      if(!newBooking){
        if(/reservado|aforo|bloquead|disponible para/i.test(lastErr)) showAlternatives(activeRoom.code, state.calDate, pendingSlot, asistentes, documento, subject);
        return;
      }
      slotsListBookings.push(newBooking);
      showToast('Solicitud enviada, pendiente de confirmación: ' + activeRoom.label + ' · ' + state.calDate + ' · ' + pendingSlot);
      notifyCoordinator(newBooking, activeRoom);
      closeBookingForm();
      renderSlotList();
      if(state.calDate === state.date){
        state.bookings = slotsListBookings;
      }
      renderRooms();
    });
  });

  function cancelBooking(slot){
    var b = bookingFor(slotsListBookings, activeRoom, slot);
    if(!b) return;
    deleteBookingById(b.id).then(function(ok){ if(!ok) return;
      slotsListBookings = slotsListBookings.filter(function(x){ return x.id !== b.id; });
      showToast('Reserva cancelada.');
      renderSlotList();
      if(state.calDate === state.date){
        state.bookings = slotsListBookings;
      }
      renderRooms();
    });
  }

  // ---------- MIS RESERVAS ----------
  var myBookingsBackdrop = document.getElementById('mybookings-backdrop');

  function roomLabelByCode(code){
    var r = ROOMS.filter(function(rm){ return rm.code === code; })[0];
    return r ? r.label : code;
  }

  function getAllMyBookings(){
    var sb = getSupabase();
    if(!sb) return Promise.resolve([]);
    return sb.from('bookings').select('*').or('app_user.eq."' + String(state.user).replace(/"/g,'') + '",user_id.eq.' + (state.profile ? state.profile.id : '00000000-0000-0000-0000-000000000000')).order('date', {ascending:true}).order('slot', {ascending:true}).then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo consultar la base de datos.');
        return [];
      }
      return (res.data || []).map(rowToBooking);
    });
  }

  function openMyBookingsModal(){
    myBookingsBackdrop.style.display = 'flex';
    document.getElementById('mybookings-empty').style.display = 'none';
    document.getElementById('mybookings-list').innerHTML = '<div class="content-sub">Cargando...</div>';
    releaseNoShows().then(renderMyBookings);
  }
  function closeMyBookingsModal(){
    myBookingsBackdrop.style.display = 'none';
  }
  document.getElementById('my-bookings-btn').addEventListener('click', openMyBookingsModal);
  document.getElementById('mybookings-close').addEventListener('click', closeMyBookingsModal);
  myBookingsBackdrop.addEventListener('click', function(e){ if(e.target === myBookingsBackdrop) closeMyBookingsModal(); });

  function renderMyBookings(){
    getAllMyBookings().then(function(mine){
      var list = document.getElementById('mybookings-list');
      var empty = document.getElementById('mybookings-empty');
      list.innerHTML = '';
      if(mine.length === 0){
        empty.style.display = 'block';
        return;
      }
      var f = document.getElementById('mybookings-filter').value;
      lastMine = mine;
      if(f) mine = mine.filter(function(b){ return b.estado === f; });
      empty.style.display = 'none';
      mine.forEach(function(b){
        var row = document.createElement('div');
        row.className = 'slot-row';
        row.innerHTML =
          '<div>' +
            '<div class="slot-time">' + roomLabelByCode(b.room) + ' · ' + b.date + ' · ' + b.slot + '</div>' +
            '<span class="slot-state">Doc. ' + escapeHtml(b.documento || '') + ' · ' + escapeHtml(b.subject || '') + ' · ' + estadoText(b) + '</span>' +
          '</div>' +
          (isActive(b) ? '<div class="row-btns" style="flex:0 0 auto;">' + opButtons(b) + '<button class="slot-btn book modify" data-id="' + b.id + '">Modificar</button><button class="slot-btn cancel" data-id="' + b.id + '" data-date="' + b.date + '">Cancelar</button></div>' : '');
        list.appendChild(row);
      });
      list.querySelectorAll('.slot-btn.cancel').forEach(function(btn){
        btn.addEventListener('click', function(){
          var id = btn.getAttribute('data-id');
          var date = btn.getAttribute('data-date');
          cancelFromMyBookings(id, date);
        });
      });
      list.querySelectorAll('[data-act]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var id = Number(btn.getAttribute('data-id')), act = btn.getAttribute('data-act');
          if(act === 'checkin') rpcDo('checkin_booking', {p_id: id}, 'Check-in registrado.', refreshMine);
          else if(act === 'extend') rpcDo('extend_booking', {p_id: id}, 'Reserva ampliada una hora.', refreshMine);
          else { outId = id; el('out-ok').value = 'ok'; el('out-desc').value = ''; el('out-backdrop').style.display = 'flex'; }
        });
      });
      list.querySelectorAll('.slot-btn.modify').forEach(function(btn){
        btn.addEventListener('click', function(){
          var b = lastMine.filter(function(x){ return String(x.id) === btn.getAttribute('data-id'); })[0];
          if(b) modifyBooking(b);
        });
      });
    });
  }

  var lastMine = [];
  document.getElementById('mybookings-filter').addEventListener('change', renderMyBookings);
  var modifying = null;
  function modifyBooking(b){
    modifying = b;
    var room = ROOMS.filter(function(r){ return r.code === b.room; })[0];
    el('modify-sub').textContent = roomLabelByCode(b.room);
    el('mod-date').value = b.date; el('mod-date').min = todayStr(); el('mod-date').max = moduleEndStr();
    el('mod-slot').innerHTML = (room ? slotsForRoom(room) : [b.slot]).map(function(s){ return '<option' + (s === b.slot ? ' selected' : '') + '>' + s + '</option>'; }).join('');
    el('mod-subject').value = b.subject || ''; el('mod-asist').value = b.asistentes || '';
    el('modify-backdrop').style.display = 'flex';
  }
  function closeModify(){ el('modify-backdrop').style.display = 'none'; }
  el('modify-close').addEventListener('click', closeModify);
  el('mod-cancel').addEventListener('click', closeModify);
  el('mod-save').addEventListener('click', function(){
    var subj = el('mod-subject').value.trim();
    if(!subj){ showToast('Escribe el motivo.'); return; }
    getSupabase().rpc('modify_booking', {p_id: Number(modifying.id), p_date: el('mod-date').value, p_slot: el('mod-slot').value, p_subject: subj, p_asistentes: parseInt(el('mod-asist').value, 10) || null}).then(function(res){
      if(res.error){ rpcErr(res); return; }
      closeModify();
      showToast('Reserva modificada; queda pendiente de confirmación.');
      renderMyBookings();
      loadBookingsForDate(state.date).then(function(list){ state.bookings = list; renderRooms(); });
    });
  });
  function cancelFromMyBookings(id, dateStr){
    deleteBookingById(id).then(function(ok){ if(!ok) return;
      showToast('Reserva cancelada.');
      renderMyBookings();
      if(dateStr === state.date){
        loadBookingsForDate(dateStr).then(function(list){
          state.bookings = list;
          renderRooms();
        });
      } else {
        renderRooms();
      }
    });
  }

  function showToast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function(){ t.style.display = 'none'; }, 2600);
  }

  function escapeHtml(str){
    var div = document.createElement('div');
    div.textContent = (str === null || str === undefined) ? '' : str;
    return div.innerHTML;
  }

})();
