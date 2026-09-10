(function(){

  // ---------- ROOM DATA ----------
  // El inventario de salones y el horario fijo YA NO están escritos aquí:
  // ahora viven en la base de datos (tablas "salones" y "horario_fijo" en Supabase,
  // ver tabla-salones-horario.sql). Estos arreglos se llenan al vuelo con loadStaticData().
  var ROOMS = [];
  var HORARIO_FIJO = [];

  // Convierte una fila de la tabla "salones" al mismo formato de objeto que usaba
  // antes el arreglo ROOMS hardcodeado, para no tocar el resto del código.
  function rowToRoom(r){
    return {
      code: r.code,
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
      ROOMS = (res.data || []).map(rowToRoom);
    });
    var horarioP = sb.from('horario_fijo').select('*').then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo cargar el horario fijo.');
        return;
      }
      HORARIO_FIJO = res.data || [];
    });
    return Promise.all([salonesP, horarioP]);
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

  // ---------- LOGIN ----------
  var COORD_USER = 'Cordinacion';
  var COORD_PASS = '12345';

  var loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', function(e){
    e.preventDefault();
    var user = document.getElementById('login-user').value.trim();
    var pass = document.getElementById('login-pass').value.trim();
    var errEl = document.getElementById('login-error');
    if(!user || !pass){
      errEl.textContent = 'Ingresa usuario y contraseña.';
      return;
    }
    errEl.textContent = '';
    if(user === COORD_USER && pass === COORD_PASS){
      document.getElementById('login-screen').style.display = 'none';
      openCoordPanel();
      return;
    }
    state.user = user;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'block';
    document.getElementById('user-name').textContent = user;
    document.getElementById('user-avatar').textContent = user.slice(0,2).toUpperCase();
    document.getElementById('date-picker').value = state.date;
    document.getElementById('date-picker').min = todayStr();
    document.getElementById('date-picker').max = moduleEndStr();
    staticDataPromise.then(function(){
      return loadBookingsForDate(state.date);
    }).then(function(list){
      state.bookings = list;
      renderRooms();
    });
  });

  document.getElementById('logout-btn').addEventListener('click', function(){
    state.user = null;
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('login-user').value = '';
    document.getElementById('login-pass').value = '';
  });

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
          '<button class="btn-ghost coord-edit" data-id="' + r.id + '" type="button">Editar</button>' +
          '<button class="btn-ghost coord-delete" data-id="' + r.id + '" type="button">Borrar</button>' +
        '</td>';
      body.appendChild(tr);
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
    return sb.from('bookings').select('*').eq('date', dateStr).then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo conectar con la base de datos.');
        return [];
      }
      return (res.data || []).map(rowToBooking);
    });
  }

  function insertBooking(dateStr, booking){
    var sb = getSupabase();
    if(!sb) return Promise.resolve(null);
    return sb.from('bookings').insert({
      date: dateStr,
      room: booking.room,
      slot: booking.slot,
      app_user: booking.user,
      documento: booking.documento,
      subject: booking.subject
    }).select().then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo guardar en la base de datos.');
        return null;
      }
      return res.data && res.data[0] ? rowToBooking(res.data[0]) : null;
    });
  }

  function deleteBookingById(id){
    var sb = getSupabase();
    if(!sb) return Promise.resolve();
    return sb.from('bookings').delete().eq('id', id).then(function(res){
      if(res.error){
        console.error(res.error);
        showToast('No se pudo cancelar en la base de datos.');
      }
    });
  }

  // ---------- CORREO AL COORDINADOR (EmailJS) ----------
  function baseUrl(){
    // Construye la URL de la página actual sin el "index.html" del final,
    // para que el link de confirmación apunte a confirmar.html en el mismo sitio.
    return window.location.href.replace(/index\.html.*$/, '');
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
    return {id:r.id, room:r.room, slot:r.slot, user:r.app_user, documento:r.documento, subject:r.subject, date:r.date, estado:r.estado, confirm_token:r.confirm_token};
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
    return ROOMS.filter(function(r){
      if(state.piso === 'todos') return true;
      if(state.piso === 'lab') return r.tipo === 'lab';
      if(state.piso === 'especial') return r.tipo === 'especial';
      return String(r.piso) === state.piso && r.tipo === 'aula';
    });
  }

  function renderRooms(){
    var grid = document.getElementById('room-grid');
    var empty = document.getElementById('empty-state');
    grid.innerHTML = '';
    var rooms = filteredRooms();
    if(rooms.length === 0){
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
          else if(b.user === state.user) mineCount++;
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
      if(!b){
        right = '<button class="slot-btn book" data-slot="' + slot + '">Agendar</button>';
      } else if(b.user === state.user){
        right = '<span class="slot-state">Doc. ' + escapeHtml(b.documento) + ' · ' + escapeHtml(b.subject) + '</span> <button class="slot-btn cancel" data-slot="' + slot + '">Cancelar</button>';
      } else {
        row.classList.add('locked');
        right = '<span class="slot-state">Reservado</span> <button class="slot-btn disabled" disabled>Ocupado</button>';
      }
      row.innerHTML = timeEl + '<span style="display:flex;align-items:center;gap:8px;">' + right + '</span>';
      list.appendChild(row);
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
    document.getElementById('booking-doc').value = '';
    document.getElementById('booking-subject').value = '';
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
    insertBooking(state.calDate, {room: activeRoom.code, slot: pendingSlot, user: state.user, documento: documento, subject: subject}).then(function(newBooking){
      if(!newBooking) return;
      slotsListBookings.push(newBooking);
      showToast('Reserva confirmada: ' + activeRoom.label + ' · ' + state.calDate + ' · ' + pendingSlot);
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
    deleteBookingById(b.id).then(function(){
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
    return sb.from('bookings').select('*').eq('app_user', state.user).order('date', {ascending:true}).order('slot', {ascending:true}).then(function(res){
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
    renderMyBookings();
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
      empty.style.display = 'none';
      mine.forEach(function(b){
        var row = document.createElement('div');
        row.className = 'slot-row';
        row.innerHTML =
          '<div>' +
            '<div class="slot-time">' + roomLabelByCode(b.room) + ' · ' + b.date + ' · ' + b.slot + '</div>' +
            '<span class="slot-state">Doc. ' + escapeHtml(b.documento || '') + ' · ' + escapeHtml(b.subject || '') + ' · ' + (b.estado === 'confirmada' ? 'Confirmada ✓' : 'Pendiente de confirmar') + '</span>' +
          '</div>' +
          '<button class="slot-btn cancel" data-id="' + b.id + '" data-date="' + b.date + '">Cancelar</button>';
        list.appendChild(row);
      });
      list.querySelectorAll('.slot-btn.cancel').forEach(function(btn){
        btn.addEventListener('click', function(){
          var id = btn.getAttribute('data-id');
          var date = btn.getAttribute('data-date');
          cancelFromMyBookings(id, date);
        });
      });
    });
  }

  function cancelFromMyBookings(id, dateStr){
    deleteBookingById(id).then(function(){
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
    div.textContent = str;
    return div.innerHTML;
  }

})();
