// ============================================================
// TransMatch — Cloudflare Worker v4  (patch retornos)
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age":       "86400",
};

function corsResponse(body, status, extra={}) {
  return new Response(body, { status, headers: { ...CORS_HEADERS, "Content-Type":"application/json", ...extra } });
}
function ok(data)        { return corsResponse(JSON.stringify(data), 200); }
function err(msg, s=400) { return corsResponse(JSON.stringify({ error:msg }), s); }

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function signToken(payload, secret) {
  const header = btoa(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const body   = btoa(JSON.stringify({ ...payload, iat:Date.now(), exp:Date.now()+86400000*7 }));
  const msg    = header+"."+body;
  const key    = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig    = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return msg+"."+btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const msg = header+"."+body;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(msg));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function uid() { return crypto.randomUUID(); }

async function generarCodigo(env, tipo) {
  const key = 'contador:' + tipo;
  const raw = await env.SESSIONS.get(key);
  const num = (parseInt(raw || '0') + 1);
  await env.SESSIONS.put(key, String(num));
  return tipo + '-' + String(num).padStart(4, '0');
}

async function getUser(request, env) {
  const auth  = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!token) return null;
  const user = await verifyToken(token, env.JWT_SECRET);
  if (!user) return null;
  // Sub-usuarios: plan y estado se heredan de la cuenta madre de forma dinámica.
  // Si la madre está suspendida (cascada) o el sub-usuario fue desactivado manualmente, se bloquea el acceso.
  if (user.esSubusuario && user.empresaMadreId) {
    const rawSelf = await env.USERS.get(user.email);
    const self = rawSelf ? JSON.parse(rawSelf) : null;
    const desactivadoManual = self ? !!self.desactivadoManual : false;
    const ef = await efectivoSubusuario(env, {
      esSubusuario: true,
      empresaMadreId: user.empresaMadreId,
      desactivadoManual,
      estado: self ? self.estado : "activo",
      plan: user.plan,
    });
    user.plan = ef.plan;
    user.estado = ef.estado;
    user.desactivadoManual = desactivadoManual;
    if (ef.bloqueado) return null;
  }
  return user;
}

function deny(user, ...roles) {
  if (!user)                      return err("No autenticado", 401);
  if (!roles.includes(user.role)) return err("Sin permisos", 403);
  return null;
}

// Carga la cuenta madre (empresa) de un sub-usuario a partir de su empresaMadreId. Devuelve el objeto usuario o null.
async function cargarMadre(env, empresaMadreId) {
  if (!empresaMadreId) return null;
  const emailMadre = await env.USERS.get("id:"+empresaMadreId);
  if (!emailMadre) return null;
  const raw = await env.USERS.get(emailMadre);
  return raw ? JSON.parse(raw) : null;
}

// Calcula el plan y estado EFECTIVOS de un usuario.
// Los sub-usuarios heredan dinámicamente el plan y el estado de su cuenta madre:
//  - plan   = plan de la madre
//  - estado = "suspendido" si fue desactivado manualmente, o el estado de la madre si no está activa (cascada), si no "activo"
// Para usuarios normales devuelve su propio plan/estado sin cambios.
async function efectivoSubusuario(env, u) {
  if (!u || !u.esSubusuario || !u.empresaMadreId) {
    const estado = u ? u.estado : undefined;
    return { plan: u ? u.plan : null, estado, bloqueado: estado==="suspendido"||estado==="rechazado", madre:null };
  }
  const madre = await cargarMadre(env, u.empresaMadreId);
  if (!madre) {
    return { plan: u.plan, estado: u.estado, bloqueado: u.estado==="suspendido"||u.estado==="rechazado", madre:null };
  }
  const plan = madre.plan || null;
  let estado;
  if (u.desactivadoManual)            estado = "suspendido";   // desactivación manual del sub-usuario
  else if (madre.estado !== "activo") estado = madre.estado;   // cascada del estado de la madre
  else                                estado = "activo";
  return { plan, estado, bloqueado: estado !== "activo", madre };
}

async function obtenerUF() {
  try {
    const res  = await fetch("https://mindicador.cl/api/uf");
    const data = await res.json();
    const v = data.serie[0].valor;
    if (v && v > 0) return v;
    return 40800;
  } catch(e) { return 40800; } // fallback aprox. UF jun-2026 (se usa solo si mindicador.cl falla)
}

function calcularComision(valorFactura, valorUF) {
  const porPorcentaje = valorFactura * 0.05;
  const tope          = valorUF * 10;
  return Math.round(Math.min(porPorcentaje, tope));
}

async function generarCodigoOV(env) {
  const key = 'contador:OV';
  const raw = await env.OVS.get(key);
  const num = (parseInt(raw || '0') + 1);
  await env.OVS.put(key, String(num));
  return 'OV-' + String(num).padStart(4, '0');
}

async function crearOV(env, { transporteId, licitacion, cotizacion }) {
  const id_ov = await generarCodigoOV(env);
  const comisionEstimada = Math.round(cotizacion.precio * 0.05);
  const ov = {
    id_ov, id_transporte:transporteId,
    id_transportista:cotizacion.transportistaId, transportistaNombre:cotizacion.transportistaNombre,
    transportistaEmpresa:cotizacion.transportistaEmpresa, transportistaEmail:cotizacion.transportistaEmail,
    id_cliente:licitacion.clienteId, clienteEmpresa:licitacion.clienteEmpresa, id_licitacion:licitacion.id,
    estado:"CONDICIONAL", monto_cotizado:cotizacion.precio, monto_facturado:null,
    comision_estimada:comisionEstimada, comision_porcentaje:5, comision_tope_uf:10,
    tope_aplicado:null, comision_final:null, uf_del_dia:null, valor_servicio_final:null,
    id_oc:null, id_factura_transportista:null, id_factura_transmatch:null, id_guia_despacho:null,
    fecha_adjudicacion:new Date().toISOString(), fecha_confirmacion:null, fecha_facturacion:null,
    fecha_pago_confirmado:null, fecha_anulacion:null, motivo_anulacion:null, observaciones:null,
    anulado_por_admin:null, metodo_pago:null,
    historial:[{ estado:"CONDICIONAL", fecha:new Date().toISOString(), actor:"sistema", nota:"OV creada al adjudicar licitación" }],
  };
  await env.OVS.put("ov:"+id_ov, JSON.stringify(ov));
  const idxAll = JSON.parse(await env.OVS.get("ovs:all")||"[]"); idxAll.unshift(id_ov); await env.OVS.put("ovs:all", JSON.stringify(idxAll));
  const idxT = JSON.parse(await env.OVS.get("ovs:transportista:"+cotizacion.transportistaId)||"[]"); idxT.unshift(id_ov); await env.OVS.put("ovs:transportista:"+cotizacion.transportistaId, JSON.stringify(idxT));
  const idxC = JSON.parse(await env.OVS.get("ovs:cliente:"+licitacion.clienteId)||"[]"); idxC.unshift(id_ov); await env.OVS.put("ovs:cliente:"+licitacion.clienteId, JSON.stringify(idxC));
  return ov;
}

function calcScore(cotizacion, fechaSolicitada) {
  const allPrecios = [cotizacion._allPrecios || []].flat();
  const precioMax = Math.max(...allPrecios, cotizacion.precio, 1);
  const precioMin = Math.min(...allPrecios, cotizacion.precio, precioMax);
  const precioRange = precioMax - precioMin || 1;
  const precioScore = 1 - ((cotizacion.precio - precioMin) / precioRange);
  let fechaScore = 0.5;
  if (fechaSolicitada && cotizacion.fechaEntregaISO) {
    const solicitada = new Date(fechaSolicitada).getTime();
    const ofrecida   = new Date(cotizacion.fechaEntregaISO).getTime();
    const diffDias   = (ofrecida - solicitada) / 86400000;
    if (diffDias <= 0)      fechaScore = 1.0;
    else if (diffDias <= 1) fechaScore = 0.85;
    else if (diffDias <= 2) fechaScore = 0.65;
    else if (diffDias <= 3) fechaScore = 0.40;
    else                    fechaScore = 0.10;
  }
  const ratingScore = (cotizacion.transportistaRating || 5) / 5;
  return (precioScore * 0.50) + (fechaScore * 0.30) + (ratingScore * 0.20);
}

// Cierra automáticamente las licitaciones abiertas cuyo plazo (cierreAt) ya venció.
// - Con cotizaciones: pasa a "cerrada" y envía las top 3 al cliente.
// - Sin cotizaciones: pasa a "expirada".
// Devuelve cuántas procesó. Es idempotente y seguro de llamar seguido.
async function procesarLicitacionesVencidas(env) {
  let procesadas = 0;
  try {
    const ids = JSON.parse(await env.LICITACIONES.get("all") || "[]");
    const ahora = Date.now();
    for (const id of ids) {
      const raw = await env.LICITACIONES.get(id);
      if (!raw) continue;
      const l = JSON.parse(raw);
      if (l.estado !== "abierta") continue;
      // Si no tiene cierreAt (licitaciones antiguas), calcularlo desde createdAt + plazo
      if (!l.cierreAt) {
        if (l.createdAt) {
          const horasPlazo = parseInt(l.plazo || "24");
          l.cierreAt = new Date(new Date(l.createdAt).getTime() + horasPlazo * 3600000).toISOString();
          await env.LICITACIONES.put(id, JSON.stringify(l));
        } else {
          continue; // sin createdAt no se puede determinar el cierre
        }
      }
      if (new Date(l.cierreAt).getTime() > ahora) continue; // aún no vence

      const cotizaciones = l.cotizaciones || [];
      if (cotizaciones.length > 0) {
        // Rankear por score (50% precio neto / 30% puntualidad / 20% rating)
        const todosPrecios = cotizaciones.map(c => c.precio);
        const ranked = cotizaciones
          .map(c => ({ ...c, _allPrecios: todosPrecios, score: calcScore({ ...c, _allPrecios: todosPrecios }, l.fechaCarga) }))
          .sort((a, b) => b.score - a.score);
        l.cotizaciones = ranked;
        l.estado = "cerrada";
        l.cerradaAt = new Date().toISOString();
        l.ronda = l.ronda || 1;
        l.cotizacionesEnviadas = ranked.slice(0, 3).map(cot => { if (!cot.id) cot.id = uid(); return cot; });
        await env.LICITACIONES.put(id, JSON.stringify(l));
        try {
          await crearNotificacion(env, l.clienteId, "cotizaciones_disponibles",
            `Tienes ${Math.min(3, ranked.length)} cotizaciones: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,
            { licitacionId: id });
          await enviarEmail(env, { to: l.clienteEmail, subject: `Tienes cotizaciones listas - TransMatch`, html: emailCotizacionesListas(l, Math.min(3, ranked.length)) });
          await registrarActividad(env,"licitacion_cerrada",`Licitación cerrada automáticamente con ${Math.min(3,ranked.length)} cotizaciones: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, codigo:l.codigo });
        } catch (e) {}
      } else {
        // Sin cotizaciones: expira
        l.estado = "expirada";
        l.expiradaAt = new Date().toISOString();
        await env.LICITACIONES.put(id, JSON.stringify(l));
        try {
          await crearNotificacion(env, l.clienteId, "licitacion_cerrada",
            `Tu licitación venció sin cotizaciones: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,
            { licitacionId: id });
          await registrarActividad(env,"licitacion_expirada",`Licitación expirada sin cotizaciones: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, codigo:l.codigo });
        } catch (e) {}
      }
      procesadas++;
    }
    // Recordatorio: licitaciones "cerradas" (con cotizaciones listas) que llevan más de 24h sin adjudicar.
    // Se envía una sola vez (marca l.recordatorioCerradaEnviado) para no enviar el mismo aviso en cada barrido.
    for (const id of ids) {
      const raw = await env.LICITACIONES.get(id);
      if (!raw) continue;
      const l = JSON.parse(raw);
      if (l.estado !== "cerrada" || l.recordatorioCerradaEnviado) continue;
      if (!l.cerradaAt) continue;
      const horasCerrada = (ahora - new Date(l.cerradaAt).getTime()) / 3600000;
      if (horasCerrada < 24) continue;
      l.recordatorioCerradaEnviado = true;
      await env.LICITACIONES.put(id, JSON.stringify(l));
      try {
        await crearNotificacion(env, l.clienteId, "recordatorio_adjudicar",
          `Tienes cotizaciones sin revisar hace más de 24h: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,
          { licitacionId: id });
        await enviarEmail(env, { to: l.clienteEmail, subject: `Recordatorio: tienes cotizaciones pendientes de revisar - TransMatch`, html: emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Tienes cotizaciones esperando</h2><p style="font-size:14px;color:#6B7280;margin:0 0 20px">Hace más de 24 horas que tu licitación <strong>${l.codigo||''}</strong> (${l.origen} → ${l.destino}) tiene cotizaciones listas para revisar y aún no la has adjudicado.</p><p style="font-size:13px;color:#6B7280">Entra a tu panel de licitaciones para revisarlas y elegir la que prefieras.</p>`,"Cotizaciones pendientes - TransMatch") });
        await registrarActividad(env,"recordatorio_adjudicar_enviado",`Recordatorio enviado: licitación cerrada sin adjudicar hace >24h: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, codigo:l.codigo });
      } catch (e) {}
    }
  } catch (e) {}
  return procesadas;
}

// Barrido diario de vencimientos de documentos de equipos.
// Corre desde el mismo cron que las licitaciones, pero se auto-limita a UNA ejecución por día
// (throttle con cron:docvenc:lastrun) para no repetir el barrido en cada disparo del cron.
// Deduplicación por "hito" (15/7/2/0 días antes y vencido) usando un store por usuario en SESSIONS,
// de modo que cada documento avisa como máximo una vez por hito y por fecha de vencimiento.
// Los documentos de un MISMO equipo que caen en un mismo barrido se agrupan en UN solo aviso
// (una notificación y un email por equipo), en vez de uno por documento.
async function procesarVencimientosDocumentos(env) {
  try {
    const hoyStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const last = await env.SESSIONS.get("cron:docvenc:lastrun");
    if (last === hoyStr) return 0; // ya se ejecutó hoy
    await env.SESSIONS.put("cron:docvenc:lastrun", hoyStr); // marcar ANTES del barrido (evita repetir cada 10 min)

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const labelMap = {
      permiso_circulacion: "Permiso de Circulación", revision_tecnica: "Revisión Técnica",
      gases: "Gases", seguro_obligatorio: "Seguro Obligatorio", poliza_empresa: "Póliza empresa", adicional: "Archivo adicional"
    };
    const estadoTexto = function (dias) {
      if (dias < 0) return "vencido hace " + Math.abs(dias) + " día" + (Math.abs(dias) === 1 ? "" : "s");
      if (dias === 0) return "vence hoy";
      return "vence en " + dias + " día" + (dias === 1 ? "" : "s");
    };
    let avisos = 0;
    const lista = await env.USERS.list();
    for (const key of lista.keys) {
      if (!key.name.includes("@")) continue; // saltar punteros "id:..." y "__test__"
      const raw = await env.USERS.get(key.name);
      if (!raw) continue;
      let u; try { u = JSON.parse(raw); } catch (e) { continue; }
      if (u.role !== "transportista") continue;
      const equipos = u.equipos || [];
      if (!equipos.length) continue; // los equipos viven en la cuenta madre; subusuarios sin equipos se saltan

      const storeKey = "docnotif:" + u.id;
      let sent = {}; try { sent = JSON.parse(await env.SESSIONS.get(storeKey) || "{}"); } catch (e) { sent = {}; }
      let cambios = false;

      for (const eq of equipos) {
        const docs = eq.documentos || {};
        const nuevos = []; // documentos de ESTE equipo con hito nuevo (aún no avisado)
        for (const dk of Object.keys(docs)) {
          const doc = docs[dk];
          if (!doc || !doc.vencimiento) continue;
          const vence = new Date(doc.vencimiento + "T12:00:00");
          if (isNaN(vence.getTime())) continue;
          const dias = Math.round((vence - hoy) / 86400000);
          // Hito por umbral (<=) para no depender del día exacto si el cron no corrió ese día
          let hito = null;
          if (dias < 0) hito = "vencido";
          else if (dias === 0) hito = "0";
          else if (dias <= 2) hito = "2";
          else if (dias <= 7) hito = "7";
          else if (dias <= 15) hito = "15";
          if (!hito) continue;

          const dedupKey = eq.id + "|" + dk + "|" + doc.vencimiento + "|" + hito;
          if (sent[dedupKey]) continue; // ya avisado para este hito/fecha
          sent[dedupKey] = hoyStr; cambios = true;
          nuevos.push({ label: doc.label || labelMap[dk] || dk, dias: dias, vencimiento: doc.vencimiento, docKey: dk });
        }
        if (!nuevos.length) continue;

        // Ordenar por urgencia (más vencido/urgente primero)
        nuevos.sort(function (a, b) { return a.dias - b.dias; });
        const equipoNom = (eq.tipo || "Equipo") + (eq.patente ? " (" + eq.patente + ")" : "");
        const hayVencido = nuevos.some(function (n) { return n.dias < 0; });

        // Mensaje agrupado para la campanita
        let mensaje;
        if (nuevos.length === 1) {
          const n = nuevos[0];
          mensaje = "Documento " + estadoTexto(n.dias) + " — " + n.label + " de " + equipoNom;
        } else {
          mensaje = equipoNom + " — " + nuevos.length + " documentos requieren atención: " +
            nuevos.map(function (n) { return n.label + " (" + estadoTexto(n.dias) + ")"; }).join(", ");
        }

        try {
          await crearNotificacion(env, u.id, "vencimiento_documento", mensaje,
            { equipoId: eq.id, docs: nuevos.map(function (n) { return n.docKey; }) });
          avisos++;
          if (u.notifEmail && u.email) {
            const filas = nuevos.map(function (n) {
              const color = n.dias < 0 ? "#B91C1C" : (n.dias <= 2 ? "#B45309" : "#6B7280");
              return '<tr><td style="padding:6px 0;font-size:13px;color:#111827">' + n.label + '</td>' +
                '<td style="padding:6px 0;font-size:13px;color:' + color + ';text-align:right">' + estadoTexto(n.dias) +
                ' · vence ' + new Date(n.vencimiento + "T12:00:00").toLocaleDateString("es-CL") + '</td></tr>';
            }).join("");
            await enviarEmail(env, {
              to: u.email,
              subject: (hayVencido ? "Documentos vencidos" : "Documentos por vencer") + " — " + equipoNom + " · TransMatch",
              html: emailBase(
                '<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Documentos de ' + equipoNom + '</h2>' +
                '<p style="font-size:14px;color:#6B7280;margin:0 0 16px">Los siguientes documentos de tu equipo requieren atención:</p>' +
                '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' + filas + '</table>' +
                '<p style="font-size:13px;color:#6B7280">Entra a tu perfil → Mis equipos para actualizarlos y mantener tu documentación al día.</p>',
                "Vencimiento de documentos - TransMatch"
              )
            });
          }
        } catch (e) {}
      }

      // Podar hitos de vencimientos muy antiguos (>120 días) para que el store no crezca sin límite
      if (cambios) {
        const limite = Date.now() - 120 * 86400000;
        const podado = {};
        for (const k of Object.keys(sent)) {
          const vd = new Date((k.split("|")[2] || "") + "T12:00:00").getTime();
          if (!isNaN(vd) && vd < limite) continue;
          podado[k] = sent[k];
        }
        await env.SESSIONS.put(storeKey, JSON.stringify(podado));
      }
    }
    return avisos;
  } catch (e) { return 0; }
}

// REACTIVADO (07-jul-2026, a pedido de Majo): matching por tipo de equipo activo, con fallback.
// Ver FALLBACK_MIN_TRANSPORTISTAS y l.modoNotificacion mas abajo para el mecanismo de fallback.
// Para volver a filtro 100% estricto (sin fallback): cambiar FALLBACK_MIN_TRANSPORTISTAS a 0.
const FALLBACK_MIN_TRANSPORTISTAS = 4;

function puedeTransportar(tiposEquipo, licitacion) {
  if (!tiposEquipo || tiposEquipo.length === 0) return false;
  if (!licitacion.tipoEquipoRequerido || licitacion.tipoEquipoRequerido === "cualquiera") return true;
  const requeridos = licitacion.tipoEquipoRequerido.split(" / ").map(s => s.toLowerCase().trim());
  return tiposEquipo.some(tipo => {
    const t = (tipo || "").toLowerCase().trim();
    return requeridos.some(req => t === req || t.includes(req) || req.includes(t));
  });
}

// Recorre transportistas activos y cuenta cuantos califican para esta licitacion segun puedeTransportar.
// Se usa UNA vez al aprobar la licitacion, para decidir el modo (estricto vs fallback) y dejarlo
// guardado en l.modoNotificacion, evitando recalcular esto en cada carga de transportista-licitaciones.html.
async function contarTransportistasQueCalifican(env, l) {
  let total = 0, califican = 0;
  try {
    const lista = await env.USERS.list();
    for (const key of lista.keys) {
      if (key.name.startsWith("id:")) continue;
      const raw = await env.USERS.get(key.name);
      if (!raw) continue;
      const u = JSON.parse(raw);
      if (u.role !== "transportista" || u.estado !== "activo") continue;
      total++;
      if (puedeTransportar(u.tiposEquipo || [], l)) califican++;
    }
  } catch (e) {}
  return { total, califican };
}

function anonimizarPreguntas(preguntas, viewerId, viewerRole) {
  if (!Array.isArray(preguntas)) return [];
  return preguntas.map(p => ({
    id: p.id,
    texto: p.texto,
    respuesta: p.respuesta || null,
    createdAt: p.createdAt,
    respondidaAt: p.respondidaAt || null,
    esTuya: viewerRole === "transportista" ? (p.transportistaId === viewerId) : false,
  }));
}

function anonimizarCliente(l) {
  return { ...l, clienteEmail:undefined, clienteNombre:undefined, clienteEmpresa: l.clienteEmpresa ? "Empresa verificada TransMatch" : "Empresa verificada", contactoOrigenNombre:undefined, contactoOrigenTelefono:undefined, contactoOrigenEmail:undefined, contactoDestinoNombre:undefined, contactoDestinoTelefono:undefined, contactoDestinoEmail:undefined, paradas: Array.isArray(l.paradas) ? l.paradas.map(p=>({direccion:p.direccion||"",horario:p.horario||"",descripcion:p.descripcion||"",contacto:undefined})) : l.paradas };
}

function anonimizarTransportista(c, revelar) {
  // El formulario contiene el detalle de la cotización (items, seguros, espera/estadía,
  // observaciones) SIN datos de empresa ni contacto del transportista, por lo que es
  // seguro mostrarlo al cliente desde la comparación, antes de adjudicar.
  const formularioSeguro = sanitizarFormularioCotiz(c.formulario);
  const base = {
    id:c.id, licitacionId:c.licitacionId, precio:c.precio, tiempoEntrega:c.tiempoEntrega,
    descripcion:c.descripcion, incluye:c.incluye, tiempoRespuesta:c.tiempoRespuesta,
    transportistaRating:c.transportistaRating, transportistaTransportes:c.transportistaTransportes,
    archivoId:c.archivoId, archivoNombre:c.archivoNombre, score:c.score, createdAt:c.createdAt,
    transportistaLabel:`Transportista Verificado ${c.transportistaRating||5}`,
    formulario: formularioSeguro,
  };
  // Al adjudicar, se revela también el archivo propio del transportista
  if (revelar) {
    base.archivoPropioId = c.archivoPropioId||null;
    base.archivoPropioNombre = c.archivoPropioNombre||null;
    base.formulario = c.formulario||null;
  }
  return base;
}

// Quita del formulario cualquier dato que pueda identificar al transportista o su empresa.
function sanitizarFormularioCotiz(f) {
  if (!f || typeof f !== "object") return null;
  const camposProhibidos = new Set([
    "transportistaNombre","transportistaEmpresa","transportistaEmail","transportistaTelefono",
    "transportistaRut","empresa","empresaNombre","empresaRut","rut","razonSocial","nombre",
    "telefono","email","contacto","contactoNombre","contactoTelefono","contactoEmail","direccionEmpresa"
  ]);
  const limpio = {};
  for (const k of Object.keys(f)) {
    if (!camposProhibidos.has(k)) limpio[k] = f[k];
  }
  return limpio;
}

async function enviarEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) { console.error("Email no enviado: falta RESEND_API_KEY"); return { ok:false, error:"sin_api_key" }; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method:"POST",
      headers:{ "Authorization":"Bearer "+env.RESEND_API_KEY, "Content-Type":"application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM||"TransMatch <noreply@transmatch.cl>", reply_to:"contacto@transmatch.cl", to:[to], subject, html }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=> "");
      console.error("Resend error", res.status, txt);
      return { ok:false, status:res.status, error:txt };
    }
    return { ok:true, status:res.status };
  } catch(e) { console.error("Email error:", e.message); return { ok:false, error:e.message }; }
}

function emailBase(contenido, titulo) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F6;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(30,45,78,.08)">
        <tr><td style="background:#1e2d4e;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
        <tr><td style="background:#ffffff;padding:26px 28px 22px;border-bottom:1px solid #EEF1F6" align="center">
          <img src="https://transmatch.cl/email-logo.png" alt="TransMatch" height="30" style="height:30px;width:auto;display:block;border:0" />
        </td></tr>
        <tr><td style="background:#ffffff;padding:32px 32px 28px">
          ${contenido}
        </td></tr>
        <tr><td style="background:#ffffff;padding:0 32px 28px">
          <div style="border-top:1px solid #EEF1F6;padding-top:20px;text-align:center;font-size:12px;color:#9CA3AF;line-height:1.6">
            Este es un correo automático de TransMatch.<br/>
            <a href="https://transmatch.cl" style="color:#1e2d4e;text-decoration:none;font-weight:500">transmatch.cl</a> · <a href="https://transmatch.cl/transportista-perfil.html" style="color:#9CA3AF;text-decoration:underline">Preferencias de notificación</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function btnEmail(href, texto, color='#1e2d4e') {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px auto 4px"><tr><td style="border-radius:10px;background:${color}"><a href="${href}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#fff;text-decoration:none;border-radius:10px">${texto}</a></td></tr></table>`;
}

function formatCLP(n) {
  return new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(n);
}

function emailLicitacionAprobada(l) {
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Tu licitacion fue aprobada</h2>
    <p style="font-size:14px;color:#6B7280;margin:0 0 20px">Los transportistas ya pueden ver y cotizar tu solicitud.</p>
    <div style="background:#F9FAFB;border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Equipo:</strong> ${l.tipoEquipo}${l.marca?' - '+l.marca:''}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Ruta:</strong> ${l.origen} - ${l.destino}</div>
      <div style="font-size:13px;color:#374151"><strong>Plazo:</strong> ${l.plazo||'24'} horas</div>
    </div>
    ${btnEmail('https://transmatch.cl/cliente-licitaciones.html','Ver mi licitacion')}`, "Tu licitacion fue aprobada - TransMatch");
}

function emailNuevaLicitacionTransportista(l) {
  const fila = (label, val) => `<tr>
      <td style="padding:11px 0;border-bottom:1px solid #F1F3F8;font-size:13px;color:#8A93A6;width:150px;vertical-align:top">${label}</td>
      <td style="padding:11px 0;border-bottom:1px solid #F1F3F8;font-size:14px;color:#1e2d4e;font-weight:600;vertical-align:top">${val}</td>
    </tr>`;
  return emailBase(`
    <div style="display:inline-block;background:#FFF3E6;color:#B45309;font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;margin-bottom:16px">Nueva oportunidad</div>
    <h1 style="font-size:22px;font-weight:700;color:#1e2d4e;margin:0 0 8px;line-height:1.25">Nueva licitación disponible</h1>
    <p style="font-size:14px;color:#6B7280;margin:0 0 22px;line-height:1.6">Hay una nueva solicitud de transporte compatible con tu operación. Revisa los detalles y envía tu cotización antes de que cierre el plazo.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #EEF1F6;border-radius:12px;padding:6px 18px;margin-bottom:24px">
      ${fila('Carga', l.tipoEquipo + (l.marca?' — '+l.marca:''))}
      ${fila('Ruta', l.origen + ' &rarr; ' + l.destino)}
      ${fila('Plazo para cotizar', (l.plazo||'24') + ' horas')}
    </table>
    ${btnEmail('https://transmatch.cl/transportista-licitaciones.html','Ver y cotizar','#FF8808')}
    <p style="font-size:12px;color:#9CA3AF;text-align:center;margin:14px 0 0">Responder rápido a las licitaciones mejora tus oportunidades.</p>`,
    "Nueva licitación disponible - TransMatch");
}

function emailNuevaLicitacionAdmin(l) {
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Nueva licitación pendiente de aprobación</h2>
    <p style="font-size:14px;color:#6B7280;margin:0 0 20px">Un cliente publicó una licitación. El plazo para los transportistas ya está corriendo, apruébala lo antes posible.</p>
    <div style="background:#F9FAFB;border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Cliente:</strong> ${l.clienteEmpresa||l.clienteNombre||'--'}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Carga:</strong> ${l.tipoEquipo}${l.marca?' - '+l.marca:''}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Ruta:</strong> ${l.origen} - ${l.destino}</div>
      <div style="font-size:13px;color:#374151"><strong>Plazo:</strong> ${l.plazo||'24'} horas (cierra ${new Date(l.cierreAt).toLocaleString('es-CL')})</div>
    </div>
    ${btnEmail('https://transmatch.cl/admin-licitaciones.html','Revisar y aprobar','#1e2d4e')}`, "Nueva licitación pendiente - TransMatch");
}

// Notifica por email a los transportistas elegibles para esta licitación.
// Decide el modo (estricto vs fallback) UNA vez aqui y lo deja guardado en l.modoNotificacion,
// para que GET /api/licitaciones reuse la misma decision sin recalcular.
// Respeta la preferencia notifPrefs['nueva-licit'] (activada por defecto).
async function notificarNuevaLicitacionTransportistas(env, l) {
  try {
    const { total, califican } = await contarTransportistasQueCalifican(env, l);
    const modoFallback = FALLBACK_MIN_TRANSPORTISTAS > 0 && califican < FALLBACK_MIN_TRANSPORTISTAS;
    l.modoNotificacion = modoFallback ? "fallback" : "estricto";
    l.transportistasCalificados = califican;
    await env.LICITACIONES.put(l.id, JSON.stringify(l));

    const lista = await env.USERS.list();
    for (const key of lista.keys) {
      if (key.name.startsWith("id:")) continue;
      const raw = await env.USERS.get(key.name);
      if (!raw) continue;
      const u = JSON.parse(raw);
      if (u.role !== "transportista" || u.estado !== "activo") continue;
      // En modo fallback notificamos a todos; en modo estricto, solo a quienes califican
      if (!modoFallback && !puedeTransportar(u.tiposEquipo || [], l)) continue;
      // Notificación in-app siempre
      try { await crearNotificacion(env, u.id, "nueva_licitacion", `Nueva licitación: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`, { licitacionId: l.id }); } catch(e) {}
      // Email solo si la preferencia 'nueva-licit' está activa (default: activa)
      const prefs = u.notifPrefs || {};
      const emailActivo = prefs['nueva-licit'] !== false; // undefined o true => enviar
      if (emailActivo && u.email) {
        try { await enviarEmail(env, { to: u.email, subject: "Nueva licitación disponible - TransMatch", html: emailNuevaLicitacionTransportista(l) }); } catch(e) {}
      }
    }
  } catch(e) {}
}


function emailCotizacionesListas(l, nCotiz) {
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Tienes cotizaciones listas!</h2>
    <p style="font-size:14px;color:#6B7280;margin:0 0 20px">Recibiste <strong>${nCotiz} cotizacion${nCotiz>1?'es':''}</strong>.</p>
    <div style="background:#F9FAFB;border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Equipo:</strong> ${l.tipoEquipo}${l.marca?' - '+l.marca:''}</div>
      <div style="font-size:13px;color:#374151"><strong>Ruta:</strong> ${l.origen} - ${l.destino}</div>
    </div>
    ${btnEmail('https://transmatch.cl/cliente-licitaciones.html','Ver cotizaciones','#FF8904')}`, "Tienes cotizaciones - TransMatch");
}

function emailAdjudicacionGanada(l, cotiz) {
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Ganaste una licitacion!</h2>
    <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:13px;color:#374151;margin-bottom:5px"><strong>Empresa:</strong> ${l.clienteEmpresa}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:5px"><strong>Contacto:</strong> ${l.clienteNombre}</div>
      <div style="font-size:13px;color:#374151"><strong>Email:</strong> ${l.clienteEmail}</div>
    </div>
    <div style="background:#F9FAFB;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Equipo:</strong> ${l.tipoEquipo}${l.marca?' - '+l.marca:''}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Ruta:</strong> ${l.origen} - ${l.destino}</div>
      <div style="font-size:13px;color:#1e2d4e;font-weight:600"><strong>Valor:</strong> ${formatCLP(cotiz.precio)}</div>
    </div>
    <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400E">
      <strong>Comision estimada TransMatch:</strong> ${formatCLP(Math.round(cotiz.precio*0.05))} (5% aprox, tope 10 UF).
    </div>
    ${btnEmail('https://transmatch.cl/transportista-transporte.html','Ver en mi panel')}`, "Ganaste! - TransMatch");
}

function emailCuentaAprobada(nombre) {
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Tu cuenta fue aprobada</h2>
    <p style="font-size:14px;color:#6B7280;margin:0 0 20px">Hola ${nombre}, ya puedes acceder a la plataforma.</p>
    ${btnEmail('https://transmatch.cl/login.html','Iniciar sesion','#1ED24E')}`, "Cuenta aprobada - TransMatch");
}

function emailOVConfirmada(ov) {
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Comision confirmada</h2>
    <p style="font-size:14px;color:#6B7280;margin:0 0 16px">El cliente subio su factura. Tu comision quedo fija.</p>
    <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>OV:</strong> ${ov.id_ov}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Factura cliente:</strong> ${formatCLP(ov.monto_facturado)}</div>
      <div style="font-size:22px;font-weight:700;color:#1e2d4e;margin-top:8px">Comision: ${formatCLP(ov.comision_final)}</div>
      <div style="font-size:11px;color:#9CA3AF;margin-top:4px">UF del dia: $${ov.uf_del_dia?.toLocaleString('es-CL')}</div>
    </div>
    ${btnEmail('https://transmatch.cl/transportista-cobros.html','Ver mis OV')}`, "Comision confirmada - TransMatch");
}

function emailFacturaMensual(factura) {
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Factura mensual TransMatch</h2>
    <p style="font-size:14px;color:#6B7280;margin:0 0 16px">Periodo: <strong>${factura.periodo}</strong></p>
    <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>OVs incluidas:</strong> ${factura.total_ovs}</div>
      <div style="font-size:22px;font-weight:700;color:#FF8904;margin-top:8px">Total: ${formatCLP(factura.total_comision)}</div>
    </div>
    <p style="font-size:13px;color:#374151">Plazo de pago: 30 dias corridos desde esta fecha.</p>
    <p style="font-size:13px;color:#374151">Transferir a TransMatch SpA y enviar comprobante a <strong>pagos@transmatch.cl</strong></p>
    ${btnEmail('https://transmatch.cl/transportista-cobros.html','Ver mis facturas')}`, "Factura mensual - TransMatch");
}

function emailPropuestaRetorno(propuesta, retorno) {
  const esTramo = propuesta.esTramoParcial;
  const ruta = esTramo
    ? `Tramo parcial: ${propuesta.origenPropuesto} - ${propuesta.destinoPropuesto}`
    : `Tramo completo: ${retorno.ciudadOrigen} - ${retorno.ciudadDestino}`;
  const fechaSol = propuesta.fechaSolicitada
    ? new Date(propuesta.fechaSolicitada+'T12:00:00').toLocaleDateString('es-CL',{day:'2-digit',month:'long',year:'numeric'})
    : null;
  return emailBase(`<h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Nueva propuesta de retorno</h2>
    <p style="font-size:14px;color:#6B7280;margin:0 0 16px"><strong>${propuesta.clienteEmpresa||propuesta.clienteNombre}</strong> quiere contratar tu retorno.</p>
    <div style="background:#F9FAFB;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Ruta solicitada:</strong> ${ruta}</div>
      ${fechaSol?`<div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Fecha solicitada:</strong> ${fechaSol}</div>`:''}
      <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong>Tu ruta publicada:</strong> ${retorno.ciudadOrigen} - ${retorno.ciudadDestino}</div>
      <div style="font-size:13px;color:#374151"><strong>Tu precio publicado:</strong> ${formatCLP(retorno.precio)}</div>
    </div>
    ${btnEmail('https://transmatch.cl/transportista-retornos.html','Ver propuesta','#FF8904')}`, "Nueva propuesta de retorno - TransMatch");
}

async function verificarVencimiento(env, ov) {
  if(ov.estado !== "FACTURADA") return ov;
  if(!ov.fecha_vencimiento) return ov;
  const ahora = new Date(); const vence = new Date(ov.fecha_vencimiento);
  if(ahora > vence) {
    ov.estado = "VENCIDA"; ov.historial = ov.historial||[];
    ov.historial.push({ estado:"VENCIDA", fecha:ahora.toISOString(), actor:"sistema", nota:"Plazo de pago de 30 días vencido." });
    await env.OVS.put("ov:"+ov.id_ov, JSON.stringify(ov));
  }
  return ov;
}

// Devuelve el conjunto de emails de la empresa del usuario (el propio + subusuarios si es cuenta madre).
// Para subusuarios devuelve solo su propio email (cada uno ve lo suyo; solo la madre ve todo).
async function emailsEmpresa(env, user) {
  const emails = new Set([user.email.toLowerCase()]);
  // Resolver la cuenta madre: si es sub-usuario, su madre; si no, él mismo.
  let madreEmail = user.email;
  if (user.esSubusuario && user.empresaMadreId) {
    const e = await env.USERS.get("id:"+user.empresaMadreId);
    if (e) { madreEmail = e; emails.add(e.toLowerCase()); }
  }
  const raw = await env.USERS.get(madreEmail);
  if (raw) {
    const u = JSON.parse(raw);
    if (Array.isArray(u.empresaMiembros)) {
      for (const em of u.empresaMiembros) { if (em) emails.add(em.toLowerCase()); }
    }
  }
  return emails;
}

// Email de la cuenta "dueña" de los datos de empresa (equipos, conductores): la madre si es sub-usuario, si no él mismo.
async function emailEmpresaTransportista(env, user) {
  if (user.esSubusuario && user.empresaMadreId) {
    const e = await env.USERS.get("id:"+user.empresaMadreId);
    if (e) return e;
  }
  return user.email;
}

// ¿Puede este usuario gestionar (editar/desactivar) este retorno?
// El que lo publicó siempre; la madre, cualquiera de su empresa; el admin, todos.
async function puedeGestionarRetorno(env, user, r) {
  if (user.role === "admin") return true;
  if (r.transportistaId === user.id) return true;
  if (!user.esSubusuario) {
    const emails = await emailsEmpresa(env, user);
    if (r.transportistaEmail && emails.has(r.transportistaEmail.toLowerCase())) return true;
  }
  return false;
}

// Email del miembro asignado a un transporte (interno). Por defecto, quien cotizó (transportistaEmail).
function asignadoDeTransporte(t) {
  return ((t.asignadoEmail || t.transportistaEmail || "")).toLowerCase();
}

// VER un transporte: cualquier miembro de la empresa (cliente o transportista) al que pertenece.
async function puedeVerTransporte(env, user, t) {
  if (user.role === "admin") return true;
  if (user.role === "cliente") {
    const eid = user.esSubusuario ? (user.empresaMadreId || user.id) : user.id;
    return (t.empresaId || t.clienteId) === eid;
  }
  if (user.role === "transportista") {
    if (!t.transportistaEmail) return false;
    const emails = await emailsEmpresa(env, user);
    return emails.has(t.transportistaEmail.toLowerCase());
  }
  return false;
}

// GESTIONAR un transporte (cambios/info/ceder): el miembro asignado o la madre (admin total de la empresa).
async function puedeGestionarTransporte(env, user, t) {
  if (user.role !== "transportista") return false;
  if (asignadoDeTransporte(t) === user.email.toLowerCase()) return true;
  if (!user.esSubusuario) {
    const emails = await emailsEmpresa(env, user);
    return t.transportistaEmail && emails.has(t.transportistaEmail.toLowerCase());
  }
  return false;
}

// Las incidencias son internas: cada lado solo ve lo que reportó, nunca lo que reportó la contraparte.
function filtrarIncidenciasPorRol(t, role) {
  if (role === "admin") return t;
  if (role === "cliente") { delete t.incidenciasTransportista; return t; }
  if (role === "transportista") { delete t.incidenciasCliente; return t; }
  delete t.incidenciasCliente; delete t.incidenciasTransportista;
  return t;
}

async function crearNotificacion(env, userId, tipo, mensaje, datos={}) {
  const id = uid();
  const notif = { id, userId, tipo, mensaje, datos, leida:false, createdAt:new Date().toISOString() };
  await env.SESSIONS.put(`notif:${userId}:${id}`, JSON.stringify(notif));
  const idx = JSON.parse(await env.SESSIONS.get(`notifs:${userId}`) || "[]");
  idx.unshift(id);
  await env.SESSIONS.put(`notifs:${userId}`, JSON.stringify(idx.slice(0,50)));
}

// Registra un evento en el feed de actividad global (visible para el admin).
// tipo: licitacion_creada | licitacion_aprobada | licitacion_rechazada | cotizacion_enviada |
//       licitacion_cerrada | licitacion_adjudicada | transporte_completado | transportista_registrado |
//       transportista_aprobado | cliente_registrado | retorno_publicado | licitacion_expirada
async function registrarActividad(env, tipo, mensaje, datos={}) {
  try {
    const evento = { id: uid(), tipo, mensaje, datos, createdAt:new Date().toISOString() };
    // Guardar el evento dentro del índice mismo (1 sola escritura en vez de 2)
    const feed = JSON.parse(await env.SESSIONS.get("actividad:index") || "[]");
    feed.unshift(evento);
    await env.SESSIONS.put("actividad:index", JSON.stringify(feed.slice(0,50))); // últimos 50 eventos
  } catch(e) {}
}

async function handleRequest(request, env) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status:204, headers:CORS_HEADERS });

  if (path === "/api/test" && method === "GET") {
    try {
      await env.USERS.put("__test__","ok");
      const val = await env.USERS.get("__test__");
      await env.USERS.delete("__test__");
      return ok({ worker:"v4", kv:val==="ok"?"ok":"error", env_jwt:!!env.JWT_SECRET, ovs_binding:!!env.OVS });
    } catch(e) { return ok({ worker:"v4", kv:"error:"+e.message }); }
  }

  if (path === "/api/auth/register" && method === "POST") {
    let body = {}; try { body = await request.json(); } catch(e) { return err("Formato invalido"); }
    const { email, password, nombre, empresa, role, telefono, whatsapp, rut, zonas, equiposIniciales,
            rutEmpresa, cargo, industrias, tiposEquipo: tiposEquipoBody, otroEquipoPendiente } = body;
    if (!email||!password||!nombre||!role) return err("Faltan campos requeridos");
    const roleNorm = role==="mandante"?"cliente":role;
    if (!["cliente","transportista","mandante"].includes(role)) return err("Rol invalido");
    if (password.length<8) return err("Contrasena minimo 8 caracteres");
    if (!email.includes("@")) return err("Email invalido");
    const emailLower = email.toLowerCase();
    const existing = await env.USERS.get(emailLower);
    if (existing) return err("Este email ya esta registrado");
    const user = {
      id:uid(), email:emailLower, password:await hashPassword(password),
      nombre, empresa:empresa||"", telefono:telefono||"", rut:rut||"",
      rutEmpresa: rutEmpresa||"", cargo: cargo||"",
      notifEmail:roleNorm==="transportista", notifWhatsapp:false, whatsapp:whatsapp||"",
      role:roleNorm, estado:roleNorm==="transportista"?"pendiente":"activo",
      plan:roleNorm==="cliente"?"basico":null,
      rating:5.0, totalTransportes:0,
      zonas:zonas||[],
      industrias: industrias||[],
      equipos:[], tiposEquipo: tiposEquipoBody||[],
      perfilCompletitud: roleNorm==="cliente" ? 40 : 30,
      createdAt:new Date().toISOString(),
    };
    if (roleNorm==="transportista" && equiposIniciales?.length>0) {
      for (const eq of equiposIniciales) {
        if (!eq.tipo) continue;
        user.equipos.push({ id:uid(), tipo:eq.tipo, marca:eq.marca||"", modelo:eq.modelo||"", ano:eq.ano||"", patente:eq.patente||"", capacidadMax:parseFloat(eq.capacidadMax)||0, largoMax:parseFloat(eq.largoMax)||0, anchoMax:parseFloat(eq.anchoMax)||0, altoMax:parseFloat(eq.altoMax)||0, descripcion:eq.descripcion||"", createdAt:new Date().toISOString() });
      }
    }
    await env.USERS.put(emailLower, JSON.stringify(user));
    await env.USERS.put("id:"+user.id, emailLower);
    // Notificar al admin si hay equipo pendiente de aprobación
    if (otroEquipoPendiente) {
      await crearNotificacion(env, "admin", "equipo_pendiente_aprobacion",
        `Nuevo tipo de equipo pendiente de aprobación: "${otroEquipoPendiente}" — registrado por ${empresa||nombre}`,
        { emailTransportista: emailLower, equipoPendiente: otroEquipoPendiente });
      // Guardar en lista de equipos pendientes
      const pendientes = JSON.parse(await env.SESSIONS.get("equipos:pendientes")||"[]");
      pendientes.unshift({ id:uid(), texto:otroEquipoPendiente, empresa:empresa||"", email:emailLower, createdAt:new Date().toISOString(), estado:"pendiente" });
      await env.SESSIONS.put("equipos:pendientes", JSON.stringify(pendientes.slice(0,100)));
    }
    // Notificar al admin del nuevo transportista registrado
    if(roleNorm === "transportista"){
      await crearNotificacion(env, "admin", "nuevo_transportista",
        `Nuevo transportista: ${empresa||nombre} — pendiente de aprobación`,
        { emailTransportista: emailLower, nombreEmpresa: empresa||nombre });
    }

    const token = await signToken({ id:user.id, email:emailLower, role:user.role, nombre:user.nombre, empresa:user.empresa, plan:user.plan }, env.JWT_SECRET);
    if(user.role==="transportista") await registrarActividad(env,"transportista_registrado",`Nuevo transportista registrado (pendiente de aprobación): ${user.empresa||user.nombre}`,{ transportistaId:user.id });
    return ok({ token, user:{ id:user.id, email:emailLower, role:user.role, nombre:user.nombre, empresa:user.empresa, plan:user.plan } });
  }


  // POST /api/auth/me/prefs — guardar preferencias de notificaciones
  if (path === "/api/auth/me/prefs" && method === "POST") {
    try {
      const user = await getUser(request, env);
      if (!user) return err("No autenticado", 401);
      let prefsBody = {}; try { prefsBody = await request.json(); } catch(e) { return err("Formato invalido"); }
      const { notifPrefs } = prefsBody;
      if (!notifPrefs) return err("Faltan preferencias");
      const raw = await env.USERS.get(user.email);
      if (!raw) return err("Usuario no encontrado", 404);
      const u = JSON.parse(raw);
      u.notifPrefs = notifPrefs;
      await env.USERS.put(user.email, JSON.stringify(u));
      return ok({ ok: true });
    } catch(e) { return err("Error interno: " + e.message, 500); }
  }

  if (path === "/api/auth/cambiar-password" && method === "POST") {
    const user = await getUser(request, env);
    if (!user) return err("No autenticado", 401);
    const { passwordActual, passwordNueva } = body;
    if (!passwordActual || !passwordNueva) return err("Faltan campos");
    if (passwordNueva.length < 8) return err("La nueva contraseña debe tener al menos 8 caracteres");
    const raw = await env.USERS.get(user.email);
    if (!raw) return err("Usuario no encontrado", 404);
    const u = JSON.parse(raw);
    const hashActual = await hashPassword(passwordActual);
    if (hashActual !== u.password) return err("La contraseña actual es incorrecta");
    u.password = await hashPassword(passwordNueva);
    await env.USERS.put(user.email, JSON.stringify(u));
    return ok({ ok: true, mensaje: "Contraseña actualizada" });
  }

  if (path === "/api/auth/login" && method === "POST") {
    let body = {}; try { body = await request.json(); } catch(e) { return err("Formato invalido"); }
    const { email, password } = body;
    if (!email||!password) return err("Email y contrasena requeridos");
    const emailLower = email.toLowerCase();
    if (emailLower===(env.ADMIN_EMAIL||"").toLowerCase()) {
      if (await hashPassword(password) !== await hashPassword(env.ADMIN_PASSWORD||"")) return err("Credenciales incorrectas",401);
      const token = await signToken({ id:"admin", email:emailLower, role:"admin", nombre:"Administrador", empresa:"TransMatch" }, env.JWT_SECRET);
      return ok({ token, role:"admin", nombre:"Administrador", empresa:"TransMatch", plan:null });
    }
    const raw = await env.USERS.get(emailLower);
    if (!raw) return err("Credenciales incorrectas",401);
    const user = JSON.parse(raw);
    if (user.password !== await hashPassword(password)) return err("Credenciales incorrectas",401);
    // Estado efectivo: los sub-usuarios heredan el estado de la cuenta madre (cascada) y respetan su desactivación manual.
    const ef = await efectivoSubusuario(env, user);
    if (ef.estado==="pendiente")  return err("Cuenta pendiente de aprobacion",403);
    if (ef.estado==="rechazado")  return err("Registro rechazado. Contacta al administrador",403);
    if (ef.estado==="suspendido") return err(user.esSubusuario && user.desactivadoManual ? "Tu acceso fue desactivado por tu empresa" : "Cuenta suspendida",403);
    const token = await signToken({ id:user.id, email:emailLower, role:user.role, nombre:user.nombre, empresa:user.empresa, plan:ef.plan, esSubusuario:user.esSubusuario||false, empresaMadreId:user.empresaMadreId||null }, env.JWT_SECRET);
    return ok({ token, role:user.role, nombre:user.nombre, empresa:user.empresa, plan:ef.plan, email:user.email||emailLower, telefono:user.telefono||"" });
  }

  if (path === "/api/auth/me" && method === "GET") {
    const user = await getUser(request, env);
    if (!user) return err("Token invalido",401);
    if (user.role==="admin") return ok({ user:{ id:"admin", email:user.email, role:"admin", nombre:"Administrador", empresa:"TransMatch", plan:null } });
    const raw = await env.USERS.get(user.email);
    if (!raw) return err("Usuario no encontrado",404);
    const u = JSON.parse(raw);
    var planOut=u.plan, estadoOut=u.estado;
    if (u.esSubusuario && u.empresaMadreId) { const ef = await efectivoSubusuario(env, u); planOut = ef.plan; estadoOut = ef.estado; }
    // Datos a nivel empresa (Mi empresa, Contactos, Operaciones, Mis equipos): heredados de la cuenta madre.
    if (u.esSubusuario && u.empresaMadreId) {
      const mEmail = await env.USERS.get("id:"+u.empresaMadreId);
      if (mEmail) { const rawM = await env.USERS.get(mEmail); if (rawM) { const m = JSON.parse(rawM);
        u.empresa=m.empresa; u.rutEmpresa=m.rutEmpresa; u.giro=m.giro; u.telEmpresa=m.telEmpresa; u.ciudadEmpresa=m.ciudadEmpresa; u.direccion=m.direccion; u.web=m.web; u.descripcion=m.descripcion; u.anosExperiencia=m.anosExperiencia; u.zonas=m.zonas; u.equipos=m.equipos; u.tiposEquipo=m.tiposEquipo; u.facturacion=m.facturacion; u.contactoOperaciones=m.contactoOperaciones; u.contactoComercial=m.contactoComercial; u.contactoFacturacion=m.contactoFacturacion; u.contactos=m.contactos; u.datosBancarios=m.datosBancarios; u.industrias=m.industrias; u.rating=m.rating; u.totalTransportes=m.totalTransportes; u.totalCotizaciones=m.totalCotizaciones;
      } }
    }
    return ok({ user:{ id:u.id, email:u.email, role:u.role, nombre:u.nombre, empresa:u.empresa, plan:planOut, rating:u.rating, totalTransportes:u.totalTransportes, estado:estadoOut, desactivadoManual:u.desactivadoManual||false, notifEmail:u.notifEmail, notifWhatsapp:u.notifWhatsapp, whatsapp:u.whatsapp, telefono:u.telefono, ciudad:u.ciudad, rut:u.rut, rutEmpresa:u.rutEmpresa, cargo:u.cargo, giro:u.giro, telEmpresa:u.telEmpresa, ciudadEmpresa:u.ciudadEmpresa, direccion:u.direccion, web:u.web, descripcion:u.descripcion, anosExperiencia:u.anosExperiencia, zonas:u.zonas||[], equipos:u.equipos||[], tiposEquipo:u.tiposEquipo||[], facturacion:u.facturacion||{}, contactoOperaciones:u.contactoOperaciones, contactoComercial:u.contactoComercial, contactoFacturacion:u.contactoFacturacion, contactos:u.contactos||[], datosBancarios:u.datosBancarios||{}, industrias:u.industrias||[], max_usuarios:u.max_usuarios||0, esSubusuario:u.esSubusuario||false, empresaMadreId:u.empresaMadreId||null, empresaMiembros:u.empresaMiembros||[], permisos:u.permisos||{}, perfilCompletitud:u.perfilCompletitud||0, totalCotizaciones:u.totalCotizaciones||0, notifPrefs:u.notifPrefs||{} } });
  }

  if (path === "/api/licitaciones" && method === "POST") {
    const user = await getUser(request, env);
    const d = deny(user,"cliente","admin"); if(d) return d;
    let body = {}; try { body = await request.json(); } catch(e) { return err("Formato invalido"); }
    const { tipoEquipo, marca, peso, dimensiones, descripcion, origen, destino, fechaCarga, fechaEntrega, plazo, archivoId, archivoNombre, tipoLicitacion, tipoCarga, cantidadBultos, pesoPorBulto, modelo, cantidadEquipos, direccionOrigen, direccionDestino, contactoOrigenNombre, contactoOrigenTelefono, contactoOrigenEmail, contactoDestinoNombre, contactoDestinoTelefono, contactoDestinoEmail, volumen, horaCarga, horaDescarga, paradas, tipoEntregaDestino, valorSeguro, requiereEstandar, estandarDetalle, estandarArchivoId, estandarArchivoNombre, tipoContenedor, cantidadContenedores, condicionContenedor, pesoVGM, mercanciaPeligrosa, claseIMO, numeroUN, refrigerado, temperaturaReefer, contSobredimensionado, contSobredimensionadoDetalle, numeroContenedor, selloContenedor } = body;
    if (!origen||!destino||!fechaCarga) return err("Faltan campos requeridos");
    const paradasNorm = Array.isArray(paradas) ? paradas.filter(p=>p&&typeof p==="object").map(p=>({direccion:String(p.direccion||"").slice(0,200),horario:String(p.horario||"").slice(0,100),contacto:String(p.contacto||"").slice(0,200),descripcion:String(p.descripcion||"").slice(0,300)})).slice(0,5) : [];
    const id = uid(); const codigo = await generarCodigo(env,'LIC');
    const licitacion = { id, codigo, clienteId:user.id, clienteEmail:user.email, clienteEmpresa:user.empresa||"", clienteNombre:user.nombre||"", clienteTelefono:user.telefono||"", empresaId:user.esSubusuario?(user.empresaMadreId||user.id):user.id, creadoPorEmail:user.email, creadoPorNombre:user.nombre||"", esCreadoPorSubusuario:user.esSubusuario||false, tipoLicitacion:tipoLicitacion||"maquinaria", tipoEquipo:tipoEquipo||tipoCarga||"Carga general", tipoEquipoRequerido:body.tipoEquipoRequerido||"cualquiera", marca:marca||"", modelo:modelo||"", cantidadEquipos:cantidadEquipos||"", tipoCarga:tipoCarga||"", cantidadBultos:cantidadBultos||"", pesoPorBulto:pesoPorBulto||"", peso:peso||"", volumen:volumen||"", dimensiones:dimensiones||"", descripcion:descripcion||"", origen, destino, direccionOrigen:direccionOrigen||"", direccionDestino:direccionDestino||"", paradas:paradasNorm, tipoEntregaDestino:tipoEntregaDestino||"no_aplica", contactoOrigenNombre:contactoOrigenNombre||"", contactoOrigenTelefono:contactoOrigenTelefono||"", contactoOrigenEmail:contactoOrigenEmail||"", contactoDestinoNombre:contactoDestinoNombre||"", contactoDestinoTelefono:contactoDestinoTelefono||"", contactoDestinoEmail:contactoDestinoEmail||"", fechaCarga, horaCarga:horaCarga||"", fechaEntrega:fechaEntrega||"", horaDescarga:horaDescarga||"", plazo:plazo||"24", valorSeguro:valorSeguro||"", requiereEstandar:!!requiereEstandar, estandarDetalle:requiereEstandar?(estandarDetalle||""):"", estandarArchivoId:requiereEstandar?(estandarArchivoId||null):null, estandarArchivoNombre:requiereEstandar?(estandarArchivoNombre||null):null, estandarRequisitos:(requiereEstandar&&Array.isArray(body.estandarRequisitos))?body.estandarRequisitos.filter(r=>r&&r.label).map(r=>({id:String(r.id||uid()),label:String(r.label).slice(0,120)})).slice(0,30):[], tipoContenedor:tipoContenedor||"", cantidadContenedores:cantidadContenedores||"", condicionContenedor:condicionContenedor||"", pesoVGM:pesoVGM||"", mercanciaPeligrosa:!!mercanciaPeligrosa, claseIMO:mercanciaPeligrosa?(claseIMO||""):"", numeroUN:mercanciaPeligrosa?(numeroUN||""):"", refrigerado:!!refrigerado, temperaturaReefer:refrigerado?(temperaturaReefer||""):"", contSobredimensionado:!!contSobredimensionado, contSobredimensionadoDetalle:contSobredimensionado?(contSobredimensionadoDetalle||""):"", numeroContenedor:numeroContenedor||"", selloContenedor:selloContenedor||"", archivoId:archivoId||null, archivoNombre:archivoNombre||null, estado:"pendiente_admin", cotizaciones:[], cotizacionesEnviadas:[], preguntas:[], ronda:0, createdAt:new Date().toISOString(), cierreAt:new Date(Date.now()+parseInt(plazo||"24")*3600000).toISOString() };
    await env.LICITACIONES.put(id, JSON.stringify(licitacion));
    const idxC = JSON.parse(await env.LICITACIONES.get("cliente:"+user.id)||"[]"); idxC.unshift(id); await env.LICITACIONES.put("cliente:"+user.id, JSON.stringify(idxC));
    const idxA = JSON.parse(await env.LICITACIONES.get("all")||"[]"); idxA.unshift(id); await env.LICITACIONES.put("all", JSON.stringify(idxA));
    await crearNotificacion(env,"admin","nueva_licitacion",`Nueva licitacion: ${licitacion.tipoEquipo} - ${origen} - ${destino}`,{ licitacionId:id });
    if(env.ADMIN_EMAIL){ try{ await enviarEmail(env,{ to:env.ADMIN_EMAIL, subject:"Nueva licitación pendiente de aprobación - TransMatch", html:emailNuevaLicitacionAdmin(licitacion) }); }catch(e){} }
    await registrarActividad(env,"licitacion_creada",`${user.empresa||user.nombre||'Cliente'} publicó una licitación: ${licitacion.tipoEquipo} (${origen} → ${destino})`,{ licitacionId:id, codigo, empresa:user.empresa });
    return ok({ ok:true, id, mensaje:"Licitacion enviada." });
  }

  if (path === "/api/licitaciones" && method === "GET") {
    const user = await getUser(request, env);
    if (!user) return err("No autenticado",401);
    // Cierre lazy: procesar licitaciones vencidas en cada carga (respaldo del cron)
    await procesarLicitacionesVencidas(env);
    let ids = [];
    if (user.role==="admin") ids = JSON.parse(await env.LICITACIONES.get("all")||"[]");
    else if (user.role==="cliente") {
      // Leer índice propio
      const idsPropios = JSON.parse(await env.LICITACIONES.get("cliente:"+user.id)||"[]");
      // Si es sub-usuario, también leer licitaciones de la cuenta madre y de otros sub-usuarios
      let idsMadre = [];
      if (user.esSubusuario && user.empresaMadreId) {
        idsMadre = JSON.parse(await env.LICITACIONES.get("cliente:"+user.empresaMadreId)||"[]");
      }
      // Si es cuenta madre, leer licitaciones de todos los sub-usuarios
      let idsSubusuarios = [];
      if (!user.esSubusuario && user.empresaMiembros && user.empresaMiembros.length > 0) {
        const emailsMiembros = user.empresaMiembros;
        // Buscar IDs de cada miembro
        for (const emailMiembro of emailsMiembros) {
          const rawMiembro = await env.USERS.get(emailMiembro);
          if (!rawMiembro) continue;
          const miembro = JSON.parse(rawMiembro);
          const idsMiembro = JSON.parse(await env.LICITACIONES.get("cliente:"+miembro.id)||"[]");
          idsSubusuarios.push(...idsMiembro);
        }
      }
      // Combinar y deduplicar
      ids = [...new Set([...idsPropios, ...idsMadre, ...idsSubusuarios])];
    }
    else if (user.role==="transportista") ids = JSON.parse(await env.LICITACIONES.get("all")||"[]");
    let equiposTransportista = [];
    let emailsEmpresaT = null;
    if (user.role==="transportista") { const emEmp=await emailEmpresaTransportista(env,user); const rawT = await env.USERS.get(emEmp); if (rawT) equiposTransportista = JSON.parse(rawT).tiposEquipo||[]; emailsEmpresaT = await emailsEmpresa(env, user); }
    const licitaciones = [];
    for (const id of ids.slice(0,100)) {
      const raw = await env.LICITACIONES.get(id); if (!raw) continue;
      let l = JSON.parse(raw);
      if (!l.codigo) { l.codigo = await generarCodigo(env,'LIC'); await env.LICITACIONES.put(id, JSON.stringify(l)); }
      if (user.role==="transportista") {
        if (["abierta","cerrada"].includes(l.estado)) { const _enFallback = !l.modoNotificacion || l.modoNotificacion==="fallback"; if (!_enFallback && !puedeTransportar(equiposTransportista,l)) continue; const _anon=anonimizarCliente(l); const cotEmp=(l.cotizaciones||[]).find(c=>c.transportistaId===user.id || (c.transportistaEmail&&emailsEmpresaT.has(c.transportistaEmail.toLowerCase()))); _anon.empresaYaCotizo=!!cotEmp; _anon.empresaCotizoNombre=(!user.esSubusuario && cotEmp)?(cotEmp.transportistaNombre||''):''; _anon.preguntas=anonimizarPreguntas(l.preguntas,user.id,'transportista'); licitaciones.push(_anon); }
        else if (["adjudicada","completada"].includes(l.estado) && l.adjudicadaA?.transportistaEmail===user.email) licitaciones.push(l);
        else continue;
      } else if (user.role==="cliente") {
        const lCopy = { ...l };
        lCopy.cotizaciones = (l.cotizacionesEnviadas||[]).map((cot,idx) => { if(!cot.id) cot.id=(l.cotizaciones||[]).find(x=>x.precio===cot.precio&&x.tiempoEntrega===cot.tiempoEntrega)?.id||('cotiz_'+idx); return anonimizarTransportista(cot); });
        lCopy.totalCotizaciones = (l.cotizaciones||[]).length;
        lCopy.preguntas = anonimizarPreguntas(l.preguntas, user.id, 'cliente');
        delete lCopy.clienteEmail;
        licitaciones.push(lCopy);
      } else licitaciones.push(l);
    }
    return ok({ licitaciones });
  }

  if (path.startsWith("/api/licitaciones/") && path.split("/").length===4 && method==="GET") {
    const id = path.split("/")[3]; const user = await getUser(request,env); if(!user) return err("No autenticado",401);
    const raw = await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l = JSON.parse(raw);
    if(user.role==="cliente"){ const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403); }
    if (user.role==="transportista") { if(!["abierta","cerrada"].includes(l.estado)) return err("Sin acceso",403); const _anonG=anonimizarCliente(l); _anonG.preguntas=anonimizarPreguntas(l.preguntas,user.id,'transportista'); return ok({ licitacion:_anonG }); }
    if (user.role==="cliente") { const lCopy={...l}; const adjId=l.adjudicadaA?.cotizacionId; lCopy.cotizaciones=(l.cotizacionesEnviadas||[]).map(c=>anonimizarTransportista(c, l.estado==="adjudicada" && c.id===adjId)); lCopy.totalCotizaciones=(l.cotizaciones||[]).length; lCopy.preguntas=anonimizarPreguntas(l.preguntas,user.id,'cliente'); return ok({ licitacion:lCopy }); }
    return ok({ licitacion:l });
  }

  if (path.startsWith("/api/licitaciones/") && path.split("/").length===4 && method==="DELETE") {
    const id = path.split("/")[3]; const user = await getUser(request,env); if(!user) return err("No autenticado",401);
    const raw = await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l = JSON.parse(raw);
    if(user.role==="cliente"){ const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403); }
    if (user.role==="cliente"&&l.estado!=="pendiente_admin") return err("Solo puedes eliminar licitaciones pendientes",403);
    await env.LICITACIONES.delete(id);
    const idxC = JSON.parse(await env.LICITACIONES.get("cliente:"+user.id)||"[]"); await env.LICITACIONES.put("cliente:"+user.id, JSON.stringify(idxC.filter(x=>x!==id)));
    const idxA = JSON.parse(await env.LICITACIONES.get("all")||"[]"); await env.LICITACIONES.put("all", JSON.stringify(idxA.filter(x=>x!==id)));
    return ok({ ok:true });
  }

  if (path === "/api/cotizaciones" && method === "POST") {
    const user = await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { licitacionId, precio, tiempoEntrega, fechaEntregaISO, fechaCargaISO, descripcion, incluye, archivoId, archivoNombre, archivoPdfId, archivoPdfNombre, formulario } = body;
    if (!licitacionId||!precio) return err("licitacionId y precio son requeridos");
    const raw = await env.LICITACIONES.get(licitacionId); if(!raw) return err("No encontrada",404);
    const l = JSON.parse(raw);
    if (l.estado!=="abierta") return err("Esta licitacion no esta abierta");
    const emailsT = await emailsEmpresa(env, user);
    if ((l.cotizaciones||[]).find(c=>c.transportistaId===user.id || (c.transportistaEmail&&emailsT.has(c.transportistaEmail.toLowerCase())))) return err("Tu empresa ya envió una cotización para esta licitación");
    const rawUser = await env.USERS.get(user.email); const userData = rawUser ? JSON.parse(rawUser) : {};
    const cotizacion = { id:uid(), codigo:await generarCodigo(env,'COT'), licitacionId, transportistaId:user.id, transportistaNombre:user.nombre, transportistaEmpresa:user.empresa, transportistaEmail:user.email, transportistaTelefono:userData.telefono||"", transportistaRating:userData.rating||5.0, transportistaTransportes:userData.totalTransportes||0, precio:parseFloat(precio), tiempoEntrega:tiempoEntrega||"", fechaCargaISO:fechaCargaISO||null, fechaEntregaISO:fechaEntregaISO||null, descripcion:descripcion||"", incluye:incluye||[], archivoId:archivoId||null, archivoNombre:archivoNombre||null, archivoPropioId:archivoPdfId||null, archivoPropioNombre:archivoPdfNombre||null, formulario:formulario||null, tiempoRespuesta:Math.floor((Date.now()-new Date(l.createdAt).getTime())/60000), score:0, createdAt:new Date().toISOString() };
    l.cotizaciones = [...(l.cotizaciones||[]), cotizacion];
    const todosPrecios = l.cotizaciones.map(c=>c.precio);
    l.cotizaciones = l.cotizaciones.map(c=>({...c,_allPrecios:todosPrecios,score:calcScore({...c,_allPrecios:todosPrecios},l.fechaCarga)})).sort((a,b)=>b.score-a.score);
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    await crearNotificacion(env,"admin","nueva_cotizacion",`Nueva cotizacion: ${l.tipoEquipo} - ${l.origen}-${l.destino} - ${formatCLP(parseFloat(precio))}`,{ licitacionId, cotizacionId:cotizacion.id });
    await registrarActividad(env,"cotizacion_enviada",`${user.empresa||user.nombre||'Transportista'} cotizó ${formatCLP(parseFloat(precio))} en ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId, cotizacionId:cotizacion.id, codigo:l.codigo });
    return ok({ ok:true, mensaje:"Cotizacion enviada." });
  }

  if (path.startsWith("/api/admin/licitacion/")&&path.endsWith("/aprobar")&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const id=path.split("/")[4]; const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    let _body={}; try{_body=await request.json();}catch(e){}
    const l=JSON.parse(raw); if(l.estado!=="pendiente_admin") return err("No esta pendiente");
    l.estado="abierta"; l.aprobadaAt=new Date().toISOString();
    l.comentarioAdmin=(_body.comentarioAdmin||"").toString().trim();
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,l.clienteId,"licitacion_aprobada",`Tu licitacion fue aprobada: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,{ licitacionId:id });
    await enviarEmail(env,{ to:l.clienteEmail, subject:"Tu licitacion fue aprobada - TransMatch", html:emailLicitacionAprobada(l) });
    // Notificar a los transportistas elegibles (in-app + email según preferencia)
    await notificarNuevaLicitacionTransportistas(env, l);
    await registrarActividad(env,"licitacion_aprobada",`Licitación aprobada y publicada: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, codigo:l.codigo });
    return ok({ ok:true });
  }

  if (path.startsWith("/api/admin/licitacion/")&&path.endsWith("/rechazar")&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const id=path.split("/")[4]; let body={}; try{body=await request.json();}catch(e){}
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); l.estado="rechazada"; l.motivoRechazo=body.motivo||"";
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,l.clienteId,"licitacion_rechazada",`Tu licitacion fue rechazada: ${body.motivo||"Contacta al administrador"}`,{ licitacionId:id });
    await registrarActividad(env,"licitacion_rechazada",`Licitación rechazada: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, codigo:l.codigo, motivo:body.motivo||"" });
    return ok({ ok:true });
  }

  if (path.startsWith("/api/admin/licitacion/")&&path.endsWith("/cerrar")&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const id=path.split("/")[4]; const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.estado!=="abierta") return err("No esta abierta");
    const cotizaciones=l.cotizaciones||[]; if(cotizaciones.length===0) return err("Sin cotizaciones");
    l.estado="cerrada"; l.cerradaAt=new Date().toISOString(); l.ronda=1;
    // Rankear por score (50% precio neto / 30% puntualidad / 20% rating) antes de enviar top 3
    const todosPrecios=cotizaciones.map(c=>c.precio);
    const ranked=cotizaciones
      .map(c=>({ ...c, _allPrecios:todosPrecios, score:calcScore({ ...c, _allPrecios:todosPrecios }, l.fechaCarga) }))
      .sort((a,b)=>b.score-a.score);
    l.cotizacionesEnviadas=ranked.slice(0,3).map(cot=>{ if(!cot.id) cot.id=uid(); return cot; });
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,l.clienteId,"cotizaciones_disponibles",`Tienes ${Math.min(3,cotizaciones.length)} cotizaciones: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,{ licitacionId:id });
    await registrarActividad(env,"licitacion_cerrada",`Licitación cerrada con ${Math.min(3,cotizaciones.length)} cotizaciones enviadas al cliente: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, codigo:l.codigo });
    await enviarEmail(env,{ to:l.clienteEmail, subject:`Tienes cotizaciones listas - TransMatch`, html:emailCotizacionesListas(l,Math.min(3,cotizaciones.length)) });
    return ok({ ok:true, enviadas:Math.min(3,cotizaciones.length) });
  }

  if (path.startsWith("/api/licitaciones/") && path.split("/").length===4 && method==="PUT") {
    const id=path.split("/")[3]; const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    if(user.role==="cliente"){ const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403); }
    if(l.estado!=="pendiente_admin" && !(l.estado==="abierta" && (!l.cotizaciones||l.cotizaciones.length===0))) return err("Ya hay cotizaciones basadas en esta información — solo puedes editar los datos de contacto");
    const campos=["tipoEquipo","tipoEquipoRequerido","marca","modelo","cantidadEquipos","peso","volumen","dimensiones","descripcion","origen","destino","direccionOrigen","direccionDestino","tipoEntregaDestino","valorSeguro","contactoOrigenNombre","contactoOrigenTelefono","contactoOrigenEmail","contactoDestinoNombre","contactoDestinoTelefono","contactoDestinoEmail","fechaCarga","horaCarga","fechaEntrega","horaDescarga","plazo","tipoCarga","cantidadBultos","pesoPorBulto","tipoContenedor","cantidadContenedores","condicionContenedor","pesoVGM","mercanciaPeligrosa","claseIMO","numeroUN","refrigerado","temperaturaReefer","contSobredimensionado","contSobredimensionadoDetalle","numeroContenedor","selloContenedor"];
    for(const k of campos){ if(body[k]!==undefined) l[k]=body[k]; }
    if(Array.isArray(body.paradas)) l.paradas=body.paradas.filter(p=>p&&typeof p==="object").map(p=>({direccion:String(p.direccion||"").slice(0,200),horario:String(p.horario||"").slice(0,100),contacto:String(p.contacto||"").slice(0,200),descripcion:String(p.descripcion||"").slice(0,300)})).slice(0,5);
    if(body.archivoId) { l.archivoId=body.archivoId; l.archivoNombre=body.archivoNombre; }
    // Estándar minero
    if(body.requiereEstandar!==undefined){
      l.requiereEstandar=!!body.requiereEstandar;
      if(l.requiereEstandar){
        if(body.estandarDetalle!==undefined) l.estandarDetalle=body.estandarDetalle||"";
        if(body.estandarArchivoId){ l.estandarArchivoId=body.estandarArchivoId; l.estandarArchivoNombre=body.estandarArchivoNombre||null; }
        if(Array.isArray(body.estandarRequisitos)) l.estandarRequisitos=body.estandarRequisitos.filter(r=>r&&r.label).map(r=>({id:String(r.id||uid()),label:String(r.label).slice(0,120)})).slice(0,30);
      } else {
        l.estandarDetalle=""; l.estandarArchivoId=null; l.estandarArchivoNombre=null; l.estandarRequisitos=[];
      }
    }
    l.updatedAt=new Date().toISOString();
    await env.LICITACIONES.put(id, JSON.stringify(l));
    return ok({ ok:true, id });
  }

  // PUT /api/licitaciones/:id/contacto — edición liviana de datos de contacto,
  // disponible aunque ya existan cotizaciones (no afecta lo que el transportista cotizó:
  // precio, ruta, fechas y equipo quedan intactos, solo cambia a quién contactar).
  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/contacto")&&method==="PUT") {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403);
    if(["anulada","expirada","rechazada"].includes(l.estado)) return err("Esta licitación ya no admite cambios");
    const camposContacto=["contactoOrigenNombre","contactoOrigenTelefono","contactoOrigenEmail","contactoDestinoNombre","contactoDestinoTelefono","contactoDestinoEmail"];
    for(const k of camposContacto){ if(body[k]!==undefined) l[k]=body[k]; }
    l.updatedAt=new Date().toISOString();
    await env.LICITACIONES.put(id, JSON.stringify(l));
    return ok({ ok:true, id });
  }

  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/anular")&&method==="POST") {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"cliente","admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.motivo) return err("motivo requerido");
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    if(user.role==="cliente"){ const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403); }
    if(!["abierta","cerrada"].includes(l.estado)) return err("Solo puedes anular licitaciones abiertas o en revision de cotizaciones");
    l.estado="anulada"; l.anuladaAt=new Date().toISOString(); l.motivoAnulacion=body.motivo; l.anuladaPor=user.role;
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,"admin","licitacion_anulada",`Licitacion anulada por cliente: ${l.tipoEquipo} - ${l.origen} - ${l.destino}. Motivo: ${body.motivo}`,{ licitacionId:id });
    // A los transportistas que cotizaron NO se les informa que fue anulada: para ellos aparece
    // simplemente como "cerrada". Solo notificación interna neutra, SIN correo.
    const yaNotif=new Set();
    for(const c of (l.cotizaciones||[])){
      if(c.transportistaId && !yaNotif.has(c.transportistaId)){
        yaNotif.add(c.transportistaId);
        try{ await crearNotificacion(env,c.transportistaId,"licitacion_cerrada",`La licitación en la que cotizaste se cerró: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,{ licitacionId:id }); }catch(e){}
      }
    }
    await registrarActividad(env,"licitacion_anulada",`Licitación anulada por el cliente: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, motivo:body.motivo });
    return ok({ ok:true });
  }

  // POST /api/licitaciones/:id/pregunta — el transportista pregunta algo sobre la carga antes de cotizar.
  // Nunca se revela su identidad al cliente (ni entre transportistas): solo se ve el texto.
  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/pregunta")&&method==="POST"&&!path.includes("/responder")) {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.texto||!body.texto.trim()) return err("Escribe tu pregunta");
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    if(l.estado!=="abierta") return err("Esta licitación ya no admite preguntas");
    const pregunta={ id:crypto.randomUUID(), texto:body.texto.trim().slice(0,500), transportistaId:user.id, respuesta:null, createdAt:new Date().toISOString(), respondidaAt:null };
    l.preguntas=l.preguntas||[]; l.preguntas.push(pregunta);
    await env.LICITACIONES.put(id, JSON.stringify(l));
    try{ await crearNotificacion(env, l.clienteId, "pregunta_licitacion", `Un transportista tiene una pregunta sobre tu licitación ${l.codigo||''}: "${pregunta.texto.slice(0,80)}"`, { licitacionId:id }); }catch(e){}
    return ok({ ok:true, pregunta:{ id:pregunta.id, texto:pregunta.texto, respuesta:null, createdAt:pregunta.createdAt, esTuya:true } });
  }

  // POST /api/licitaciones/:id/pregunta/:preguntaId/responder — el cliente responde.
  // La respuesta la ve CUALQUIER transportista que consulte la licitación (no solo quien preguntó),
  // para que todos coticen con la misma información — igual que un Q&A público de licitación.
  if (path.match(/^\/api\/licitaciones\/[^/]+\/pregunta\/[^/]+\/responder$/)&&method==="POST") {
    const parts=path.split("/"); const id=parts[3]; const preguntaId=parts[5];
    const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.respuesta||!body.respuesta.trim()) return err("Escribe una respuesta");
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403);
    const pregunta=(l.preguntas||[]).find(p=>p.id===preguntaId); if(!pregunta) return err("Pregunta no encontrada",404);
    pregunta.respuesta=body.respuesta.trim().slice(0,1000); pregunta.respondidaAt=new Date().toISOString();
    await env.LICITACIONES.put(id, JSON.stringify(l));
    try{ await crearNotificacion(env, pregunta.transportistaId, "pregunta_respondida", `Respondieron tu pregunta sobre una licitación: "${pregunta.respuesta.slice(0,80)}"`, { licitacionId:id }); }catch(e){}
    return ok({ ok:true });
  }

  // POST /api/licitaciones/:id/ampliar-plazo — reabrir una licitación expirada con un nuevo plazo
  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/ampliar-plazo")&&method==="POST") {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"cliente","admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){}
    const horas=parseInt(body.plazo||"0");
    if(!horas || horas<1) return err("Indica un plazo válido");
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    if(user.role==="cliente"){ const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403); }
    if(l.estado!=="expirada") return err("Solo puedes ampliar el plazo de una licitación que venció sin cotizaciones");
    l.estado="abierta";
    l.plazo=String(horas);
    l.cierreAt=new Date(Date.now()+horas*3600000).toISOString();
    l.ampliadaAt=new Date().toISOString();
    l.vecesAmpliada=(l.vecesAmpliada||0)+1;
    delete l.expiradaAt;
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await registrarActividad(env,"licitacion_ampliada",`Plazo ampliado por el cliente (${horas}h): ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id });
    return ok({ ok:true, cierreAt:l.cierreAt });
  }

  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/mas-cotizaciones")&&method==="POST") {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    // El plan que cuenta es el de la empresa (cuenta madre). Si es subusuario, leer el plan de la madre.
    let planEfectivo=user.plan;
    if(user.esSubusuario && user.empresaMadreId){
      const rawMadre=await env.USERS.get("id:"+user.empresaMadreId);
      let emailMadre=rawMadre;
      if(emailMadre){ const m=await env.USERS.get(emailMadre); if(m) planEfectivo=JSON.parse(m).plan; }
    }
    if(!["pro","enterprise"].includes(planEfectivo)) return err("Solicitar más cotizaciones es una función de los planes Pro y Enterprise. Tu plan actual recibe las 3 cotizaciones iniciales.",403);
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if((l.empresaId||l.clienteId)!==(user.esSubusuario?(user.empresaMadreId||user.id):user.id)) return err("Sin acceso",403);
    if(l.estado!=="cerrada") return err("No esta en revision");
    const yaIds=new Set((l.cotizacionesEnviadas||[]).map(c=>c.id));
    // Ordenar todas las cotizaciones por score y tomar las siguientes 3 que aún no se mostraron
    const restantes=(l.cotizaciones||[]).filter(c=>!yaIds.has(c.id)).sort((a,b)=>(b.score||0)-(a.score||0));
    const extras=restantes.slice(0,3);
    if(extras.length===0) return err("No hay más cotizaciones disponibles");
    // Acumular: se mantienen las anteriores y se agregan las nuevas
    l.cotizacionesEnviadas=[...(l.cotizacionesEnviadas||[]),...extras]; l.ronda=(l.ronda||1)+1;
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await registrarActividad(env,"mas_cotizaciones",`Cliente solicitó más cotizaciones: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id });
    return ok({ ok:true, nuevas:extras.length });
  }

  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/adjudicar")&&method==="POST") {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"cliente","admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { cotizacionId } = body; if(!cotizacionId) return err("cotizacionId requerido");
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(user.role==="cliente"){ const _eid=(user.esSubusuario?(user.empresaMadreId||user.id):user.id); if((l.empresaId||l.clienteId)!==_eid) return err("Sin acceso",403); }
    if(!["cerrada","abierta"].includes(l.estado)) return err("No se puede adjudicar");
    let cotiz=(l.cotizaciones||[]).find(c=>c.id===cotizacionId);
    if(!cotiz) { const enviadas=l.cotizacionesEnviadas||[]; const idxMatch=cotizacionId.match(/^cotiz_(\d+)$/); if(idxMatch){cotiz=enviadas[parseInt(idxMatch[1])];if(cotiz?.id)cotiz=(l.cotizaciones||[]).find(c=>c.id===cotiz.id)||cotiz;}else{cotiz=enviadas.find(c=>c.id===cotizacionId);} }
    if(!cotiz) return err("Cotizacion no encontrada");
    l.estado="adjudicada"; l.adjudicadaAt=new Date().toISOString();
    l.adjudicadaA={ cotizacionId, precio:cotiz.precio, transportistaId:cotiz.transportistaId, transportistaNombre:cotiz.transportistaNombre, transportistaEmpresa:cotiz.transportistaEmpresa, transportistaEmail:cotiz.transportistaEmail, transportistaTelefono:cotiz.transportistaTelefono, tiempoEntrega:cotiz.tiempoEntrega, archivoPropioId:cotiz.archivoPropioId||null, archivoPropioNombre:cotiz.archivoPropioNombre||null, formulario:cotiz.formulario||null };
    await env.LICITACIONES.put(id, JSON.stringify(l));
    const codigoTRN=await generarCodigo(env,"TRN"); const transporteId=uid();
    // Obtener datos de facturación del cliente (empresa madre) para que el transportista facture
    let clienteFacturacion=null;
    try {
      const cliEmpId = l.empresaId||l.clienteId;
      const cliEmail = await env.USERS.get("id:"+cliEmpId);
      const rawCli = cliEmail ? await env.USERS.get(cliEmail) : (l.clienteEmail?await env.USERS.get(l.clienteEmail.toLowerCase()):null);
      if(rawCli){
        const cu=JSON.parse(rawCli);
        const f=cu.facturacion||{};
        clienteFacturacion={
          razonSocial: f.razonSocial||cu.empresa||l.clienteEmpresa||"",
          rut: f.rut||cu.rutEmpresa||"",
          giro: f.giro||cu.giro||"",
          direccion: f.direccion||cu.direccion||"",
          email: f.email||cu.email||l.clienteEmail||"",
          contactoNombre: f.contactoNombre||"",
          telefono: f.telefono||cu.telefono||l.clienteTelefono||""
        };
      }
    } catch(e){}
    const transporte={ id:transporteId, codigo:codigoTRN, licitacionId:id, empresaId:l.empresaId||l.clienteId, creadoPorEmail:l.creadoPorEmail||l.clienteEmail, creadoPorNombre:l.creadoPorNombre||l.clienteNombre||'', licitacionCodigo:l.codigo||"", tipoEquipo:l.tipoEquipo+(l.marca?" - "+l.marca:""), origen:l.origen, destino:l.destino, precio:cotiz.precio, clienteEmail:l.clienteEmail, clienteEmpresa:l.clienteEmpresa, clienteNombre:l.clienteNombre||"", clienteTelefono:l.clienteTelefono||"", clienteFacturacion:clienteFacturacion, requisitosEstandar:(Array.isArray(l.estandarRequisitos)?l.estandarRequisitos.map(r=>({id:r.id,label:r.label,archivoId:null,archivoNombre:null,subidoAt:null})):[]), transportistaEmail:cotiz.transportistaEmail, transportistaNombre:cotiz.transportistaNombre, transportistaEmpresa:cotiz.transportistaEmpresa, transportistaTelefono:cotiz.transportistaTelefono||"", estado:"preparacion", estadoDocumentos:"pendiente", historial:[{ estado:"preparacion", nota:"Transporte creado al adjudicar", fecha:new Date().toISOString(), actor:"Sistema" }], oc:null, factura:null, adjudicadoAt:new Date().toISOString() };
    await env.RETORNOS.put("transporte:"+transporteId, JSON.stringify(transporte));
    const allT=JSON.parse(await env.RETORNOS.get("transportes:all")||"[]"); allT.unshift(transporteId); await env.RETORNOS.put("transportes:all", JSON.stringify(allT));
    const ov = await crearOV(env, { transporteId, licitacion:l, cotizacion:cotiz });
    await crearNotificacion(env,cotiz.transportistaId,"adjudicacion",`Ganaste: ${l.tipoEquipo} - ${l.origen} - ${l.destino} - ${formatCLP(cotiz.precio)}`,{ licitacionId:id, clienteEmpresa:l.clienteEmpresa, clienteEmail:l.clienteEmail, ovId:ov.id_ov });
    await registrarActividad(env,"licitacion_adjudicada",`Licitación adjudicada a ${cotiz.transportistaEmpresa||cotiz.transportistaNombre} por ${formatCLP(cotiz.precio)}: ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId:id, codigo:l.codigo, ovId:ov.id_ov });
    await enviarEmail(env,{ to:cotiz.transportistaEmail, subject:`Ganaste! ${l.tipoEquipo} - TransMatch`, html:emailAdjudicacionGanada(l,cotiz) });
    await crearNotificacion(env,cotiz.transportistaId,"ov_condicional",`OV ${ov.id_ov} creada. Comision estimada: ${formatCLP(ov.comision_estimada)}.`,{ ovId:ov.id_ov });
    const todasCotiz=l.cotizaciones||[];
    const total=todasCotiz.length;
    // Ranking por precio (menor es mejor)
    const porPrecio=[...todasCotiz].sort((a,b)=>(a.precio||0)-(b.precio||0));
    // Ranking por fecha de entrega (más temprana es mejor)
    const fEntrega=function(c){ var f=(c.formulario&&c.formulario.fechaEntrega)||c.fechaEntregaISO||c.tiempoEntrega; var t=f?new Date(f).getTime():NaN; return isNaN(t)?Infinity:t; };
    const porEntrega=[...todasCotiz].sort((a,b)=>fEntrega(a)-fEntrega(b));
    // Ranking por valoración histórica del transportista (mayor es mejor)
    const porValoracion=[...todasCotiz].sort((a,b)=>(b.transportistaRating||0)-(a.transportistaRating||0));
    for (const c of todasCotiz) {
      if(c.transportistaId===cotiz.transportistaId) continue;
      const posPrecio=porPrecio.findIndex(x=>x.id===c.id)+1;
      const posEntrega=porEntrega.findIndex(x=>x.id===c.id)+1;
      const posValoracion=porValoracion.findIndex(x=>x.id===c.id)+1;
      await crearNotificacion(env,c.transportistaId,"licitacion_cerrada",
        `La licitacion fue adjudicada a otro transportista.`,
        { licitacionId:id, feedback:{ posPrecio, posEntrega, posValoracion, total } });
    }
    return ok({ ok:true, transportista:l.adjudicadaA, ovId:ov.id_ov });
  }

  if (path === "/api/valoraciones" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { transporteId, scores, promedio, comentario } = body;
    let { licitacionId } = body;
    if(!transporteId && !licitacionId) return err("transporteId requerido");
    const prom=promedio||(scores?Math.round((Object.values(scores).reduce((a,b)=>a+b,0)/Object.values(scores).length)*10)/10:5);

    // Flujo principal: valorar desde el transporte (debe estar entregado + facturado)
    let transporte=null;
    if(transporteId){
      const rawT=await env.RETORNOS.get("transporte:"+transporteId); if(!rawT) return err("Transporte no encontrado",404);
      transporte=JSON.parse(rawT);
      const miEmpId=user.esSubusuario?(user.empresaMadreId||user.id):user.id;
      if((transporte.empresaId||transporte.clienteId)!==miEmpId) return err("Sin acceso",403);
      if(transporte.estado!=="entregado" || !transporte.factura) return err("Solo puedes valorar transportes completados");
      if(transporte.valoracion) return err("Ya valoraste este transporte");
      licitacionId=transporte.licitacionId;
    }

    const raw=await env.LICITACIONES.get(licitacionId); if(!raw) return err("Licitación no encontrada",404);
    const l=JSON.parse(raw); if(l.clienteEmail!==user.email && (l.empresaId||l.clienteId)!==(user.esSubusuario?(user.empresaMadreId||user.id):user.id)) return err("Sin acceso",403);
    if(l.valoracion) return err("Ya valoraste");
    const valoracion={ scores:scores||{}, promedio:prom, comentario:comentario||"", createdAt:new Date().toISOString() };
    l.valoracion=valoracion; l.estado="completada";
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    // Marcar el transporte como valorado
    if(transporte){
      transporte.valoracion=valoracion;
      await env.RETORNOS.put("transporte:"+transporteId, JSON.stringify(transporte));
    }
    if(l.adjudicadaA?.transportistaEmail) {
      const rawU=await env.USERS.get(l.adjudicadaA.transportistaEmail);
      if(rawU){ const tu=JSON.parse(rawU); const prev=tu.totalTransportes||0; tu.totalTransportes=prev+1; tu.rating=Math.round(((((tu.rating||5)*prev)+prom)/tu.totalTransportes)*10)/10; await env.USERS.put(l.adjudicadaA.transportistaEmail, JSON.stringify(tu)); }
    }
    await registrarActividad(env,"transporte_completado",`Transporte completado y valorado (${prom}★): ${l.tipoEquipo} (${l.origen} → ${l.destino})`,{ licitacionId, codigo:l.codigo, promedio:prom });
    return ok({ ok:true, promedio:prom });
  }

  // ── RETORNOS ────────────────────────────────────────────────

  if (path === "/api/retornos" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { ciudadOrigen, ciudadDestino, fecha, fechaDesde, fechaHasta, equipo, capacidad, precio, descripcion } = body;
    if(!ciudadOrigen||!ciudadDestino) return err("ciudadOrigen y ciudadDestino requeridos");
    if(!equipo) return err("equipo requerido"); if(!capacidad) return err("capacidad requerida"); if(!precio) return err("precio requerido");
    const id=uid();
    const retorno={ id, transportistaId:user.id, transportistaNombre:user.nombre, transportistaEmpresa:user.empresa, transportistaEmail:user.email, transportistaRating:user.rating||5.0, ciudadOrigen, ciudadDestino, fecha:fechaDesde||fecha||null, fechaDesde:fechaDesde||null, fechaHasta:fechaHasta||null, equipo:equipo||"", capacidad:capacidad||"", precio:precio?parseFloat(precio):null, descripcion:descripcion||"", estado:"disponible", createdAt:new Date().toISOString() };
    await env.RETORNOS.put(id, JSON.stringify(retorno));
    const idx=JSON.parse(await env.RETORNOS.get("all")||"[]"); idx.unshift(id); await env.RETORNOS.put("all", JSON.stringify(idx));
    await registrarActividad(env,"retorno_publicado",`${user.empresa||user.nombre||'Transportista'} publicó un retorno: ${ciudadOrigen} → ${ciudadDestino}`,{ retornoId:id });
    return ok({ ok:true, id, mensaje:"Retorno publicado." });
  }

  if (path === "/api/retornos" && method === "GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role==="cliente"&&!["pro","enterprise"].includes(user.plan)) return err("Requiere plan Pro o Enterprise",403);
    const ids=JSON.parse(await env.RETORNOS.get("all")||"[]");
    // Para transportistas: la madre ve todos los retornos de su empresa; el sub-usuario solo los que publicó.
    let scopeEmails=null;
    if(user.role==="transportista"){
      scopeEmails = user.esSubusuario ? new Set([user.email.toLowerCase()]) : await emailsEmpresa(env,user);
    }
    const retornos=[];
    for (const id of ids.slice(0,50)) {
      const raw=await env.RETORNOS.get(id); if(!raw) continue;
      const r=JSON.parse(raw);
      if(user.role==="cliente"){ if(r.estado!=="disponible") continue; delete r.transportistaEmail; retornos.push(r); }
      else if(user.role==="transportista"){ if(!r.transportistaEmail||!scopeEmails.has(r.transportistaEmail.toLowerCase())) continue; retornos.push(r); }
      else { retornos.push(r); }
    }
    return ok({ retornos });
  }

  // ── PROPUESTAS: cliente envía propuesta a un retorno ────────
  // POST /api/retornos/:id/propuesta
  if (path.match(/^\/api\/retornos\/[^/]+\/propuesta$/) && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    if(!["pro","enterprise"].includes(user.plan)) return err("Requiere plan Pro o Enterprise",403);
    const retornoId=path.split("/")[3];
    const raw=await env.RETORNOS.get(retornoId); if(!raw) return err("Retorno no encontrado",404);
    const retorno=JSON.parse(raw);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { origenPropuesto, destinoPropuesto, esTramoParcial, fechaSolicitada } = body;
    const propuestaId=uid();
    const propuesta={
      id:propuestaId, retornoId,
      clienteId:user.id, clienteEmail:user.email, clienteEmpresa:user.empresa||"", clienteNombre:user.nombre||"", clienteTelefono:user.telefono||"",
      origenPropuesto:origenPropuesto||retorno.ciudadOrigen,
      destinoPropuesto:destinoPropuesto||retorno.ciudadDestino,
      esTramoParcial:!!esTramoParcial,
      fechaSolicitada:fechaSolicitada||null,   // ← NUEVO
      estado:"pendiente", precioNegociado:null,
      createdAt:new Date().toISOString()
    };
    await env.RETORNOS.put("propuesta:"+propuestaId, JSON.stringify(propuesta));
    const idxR=JSON.parse(await env.RETORNOS.get("propuestas:retorno:"+retornoId)||"[]"); idxR.unshift(propuestaId); await env.RETORNOS.put("propuestas:retorno:"+retornoId, JSON.stringify(idxR));
    const idxT=JSON.parse(await env.RETORNOS.get("propuestas:transportista:"+retorno.transportistaId)||"[]"); idxT.unshift(propuestaId); await env.RETORNOS.put("propuestas:transportista:"+retorno.transportistaId, JSON.stringify(idxT));
    const idxC=JSON.parse(await env.RETORNOS.get("propuestas:cliente:"+user.id)||"[]"); idxC.unshift(propuestaId); await env.RETORNOS.put("propuestas:cliente:"+user.id, JSON.stringify(idxC));
    const rutaTexto=esTramoParcial?`Tramo parcial: ${origenPropuesto} - ${destinoPropuesto}`:`Tramo completo: ${retorno.ciudadOrigen} - ${retorno.ciudadDestino}`;
    await crearNotificacion(env,retorno.transportistaId,"propuesta_retorno",`Nueva propuesta de ${user.empresa||user.nombre}: ${rutaTexto}`,{ propuestaId, retornoId, clienteEmpresa:user.empresa });
    await enviarEmail(env,{ to:retorno.transportistaEmail, subject:`Nueva propuesta de retorno - TransMatch`, html:emailPropuestaRetorno(propuesta,retorno) });
    return ok({ ok:true, propuestaId, mensaje:"Propuesta enviada al transportista." });
  }

  // ── PROPUESTAS: transportista responde ──────────────────────
  // POST /api/propuestas/:id/responder
  if (path.match(/^\/api\/propuestas\/[^/]+\/responder$/) && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const propuestaId=path.split("/")[3];
    const raw=await env.RETORNOS.get("propuesta:"+propuestaId); if(!raw) return err("Propuesta no encontrada",404);
    const propuesta=JSON.parse(raw);
    const rawR=await env.RETORNOS.get(propuesta.retornoId); if(!rawR) return err("Retorno no encontrado",404);
    const retorno=JSON.parse(rawR);
    if(retorno.transportistaId!==user.id) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { accion, precioNegociado } = body;
    if(!["aceptar","rechazar"].includes(accion)) return err("accion debe ser aceptar o rechazar");
    propuesta.estado=accion==="aceptar"?"aceptada":"rechazada";
    propuesta.precioNegociado=accion==="aceptar"?(parseFloat(precioNegociado)||retorno.precio):null;
    propuesta.respondidaAt=new Date().toISOString();
    if(accion==="aceptar") {
      propuesta.contactoTransportista={ nombre:user.nombre, empresa:user.empresa, email:user.email, telefono:user.telefono||"" };
      propuesta.contactoCliente={ nombre:propuesta.clienteNombre, empresa:propuesta.clienteEmpresa, email:propuesta.clienteEmail };
    }
    await env.RETORNOS.put("propuesta:"+propuestaId, JSON.stringify(propuesta));
    const msg=accion==="aceptar"
      ?`Tu propuesta fue aceptada por ${user.empresa||user.nombre}. Precio: ${formatCLP(propuesta.precioNegociado)}.`
      :`Tu propuesta fue rechazada por ${user.empresa||user.nombre}.`;
    await crearNotificacion(env,propuesta.clienteId,"propuesta_retorno_respuesta",msg,{ propuestaId, retornoId:propuesta.retornoId, accion, precioNegociado:propuesta.precioNegociado });
    return ok({ ok:true, accion, precioNegociado:propuesta.precioNegociado });
  }

  // ── PROPUESTAS: listar (transportista ve las suyas, cliente ve las suyas) ──
  // GET /api/propuestas
  if (path === "/api/propuestas" && method === "GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    let ids=[];
    if(user.role==="transportista") ids=JSON.parse(await env.RETORNOS.get("propuestas:transportista:"+user.id)||"[]");
    else if(user.role==="cliente") ids=JSON.parse(await env.RETORNOS.get("propuestas:cliente:"+user.id)||"[]");
    else return err("Sin permisos",403);
    const propuestas=[];
    for(const id of ids.slice(0,50)){ const raw=await env.RETORNOS.get("propuesta:"+id); if(raw) propuestas.push(JSON.parse(raw)); }
    return ok({ propuestas });
  }

  // ── PROPUESTAS por retorno (transportista ve propuestas de un retorno específico) ──
  // GET /api/retornos/:id/propuestas
  if (path.match(/^\/api\/retornos\/[^/]+\/propuestas$/) && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const retornoId=path.split("/")[3];
    const rawR=await env.RETORNOS.get(retornoId); if(!rawR) return err("Retorno no encontrado",404);
    const retorno=JSON.parse(rawR);
    if(retorno.transportistaId!==user.id) return err("Sin acceso",403);
    const ids=JSON.parse(await env.RETORNOS.get("propuestas:retorno:"+retornoId)||"[]");
    const propuestas=[];
    for(const id of ids.slice(0,50)){ const raw=await env.RETORNOS.get("propuesta:"+id); if(raw) propuestas.push(JSON.parse(raw)); }
    return ok({ propuestas });
  }

  // ── ADMIN: ver TODOS los retornos publicados con sus propuestas ──
  // GET /api/admin/retornos
  if (path === "/api/admin/retornos" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const ids=JSON.parse(await env.RETORNOS.get("all")||"[]");
    const retornos=[];
    for (const id of ids.slice(0,200)) {
      const raw=await env.RETORNOS.get(id); if(!raw) continue;
      const r=JSON.parse(raw);
      const propIds=JSON.parse(await env.RETORNOS.get("propuestas:retorno:"+id)||"[]");
      const propuestas=[];
      for(const pid of propIds.slice(0,50)){ const praw=await env.RETORNOS.get("propuesta:"+pid); if(praw) propuestas.push(JSON.parse(praw)); }
      r.propuestas=propuestas;
      retornos.push(r);
    }
    return ok({ retornos });
  }

  // ── PROPUESTA del cliente para un retorno específico ────────
  // GET /api/retornos/:id/mi-propuesta
  if (path.match(/^\/api\/retornos\/[^/]+\/mi-propuesta$/) && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    const retornoId=path.split("/")[3];
    const ids=JSON.parse(await env.RETORNOS.get("propuestas:cliente:"+user.id)||"[]");
    for(const id of ids){
      const raw=await env.RETORNOS.get("propuesta:"+id); if(!raw) continue;
      const p=JSON.parse(raw);
      if(p.retornoId===retornoId){
        // Enriquecer con datos de contacto si fue aceptada
        if(p.estado==="aceptada"&&p.contactoTransportista){
          p.transportistaNombre=p.contactoTransportista.nombre;
          p.transportistaEmpresa=p.contactoTransportista.empresa;
          p.transportistaEmail=p.contactoTransportista.email;
          p.transportistaTelefono=p.contactoTransportista.telefono;
          p.precio=p.precioNegociado;
        }
        return ok({ propuesta:p });
      }
    }
    return ok({ propuesta:null });
  }

  if (path === "/api/equipos" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"transportista","admin"); if(d) return d;
    let email;
    if(user.role==="admin"){ email=url.searchParams.get("email")||user.email; }
    else { email=await emailEmpresaTransportista(env,user); } // equipos a nivel empresa
    const raw=await env.USERS.get(email); if(!raw) return err("No encontrado",404);
    return ok({ equipos:JSON.parse(raw).equipos||[] });
  }

  if (path === "/api/equipos" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.tipo) return err("tipo requerido");
    const emailEmp=await emailEmpresaTransportista(env,user);
    const raw=await env.USERS.get(emailEmp); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw); if(!u.equipos) u.equipos=[];
    const equipo={ id:uid(), tipo:body.tipo, marca:body.marca||"", modelo:body.modelo||"", ano:body.ano||"", capacidadMax:parseFloat(body.capacidadMax)||0, largoMax:parseFloat(body.largoMax)||0, anchoMax:parseFloat(body.anchoMax)||0, altoMax:parseFloat(body.altoMax)||0, patente:body.patente||"", descripcion:body.descripcion||"", documentos:body.documentos||{}, createdAt:new Date().toISOString() };
    u.equipos.push(equipo);
    await env.USERS.put(emailEmp, JSON.stringify(u));
    return ok({ ok:true, id:equipo.id });
  }

  if (path.startsWith("/api/equipos/")&&path.split("/").length===4&&method==="DELETE") {
    const equipoId=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const emailEmp=await emailEmpresaTransportista(env,user);
    const raw=await env.USERS.get(emailEmp); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw); u.equipos=(u.equipos||[]).filter(e=>e.id!==equipoId);
    await env.USERS.put(emailEmp, JSON.stringify(u));
    return ok({ ok:true });
  }

  // POST /api/notificaciones-equipo — notificación interna de vencimiento de documentos
  if (path === "/api/notificaciones-equipo" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.mensaje) return err("mensaje requerido");
    await crearNotificacion(env, user.id, body.tipo||"vencimiento_documento", body.mensaje, body.datos||{});
    return ok({ ok:true });
  }

  // ── SEED DE DATOS DE PRUEBA (solo admin, temporal) ──────────────
  if (path === "/api/admin/seed-demo" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){}

    // 1. Encontrar cliente y transportistas (auto-detección o por email)
    const lista = await env.USERS.list();
    let cliente=null; const transportistasReales=[];
    for (const key of lista.keys) {
      const raw=await env.USERS.get(key.name); if(!raw) continue;
      const u=JSON.parse(raw);
      if(u.role==="cliente" && !u.esSubusuario){
        if(body.clienteEmail){ if(u.email===body.clienteEmail) cliente=u; }
        else if(!cliente) cliente=u;
      }
      if(u.role==="transportista" && u.estado==="activo") transportistasReales.push(u);
    }
    if(!cliente) return err("No se encontró ningún cliente. Crea una cuenta de cliente primero o pasa clienteEmail.");

    // 2. Pool de transportistas para las cotizaciones: reales primero, luego ficticios
    const ficticios=[
      { id:"demo-t1", nombre:"Felipe Soto",     empresa:"Transportes Andinos SpA",    email:"felipe@andinos.cl",      telefono:"+56 9 7012 3456", rating:4.8, totalTransportes:34 },
      { id:"demo-t2", nombre:"María González",  empresa:"Logística del Sur Ltda",     email:"maria@logsur.cl",        telefono:"+56 9 7023 4567", rating:4.6, totalTransportes:21 },
      { id:"demo-t3", nombre:"Jorge Riquelme",  empresa:"Cargas Pesadas Atacama",     email:"jorge@cpatacama.cl",     telefono:"+56 9 7034 5678", rating:4.9, totalTransportes:52 },
      { id:"demo-t4", nombre:"Daniela Muñoz",   empresa:"TransNorte Maquinaria",      email:"daniela@transnorte.cl",  telefono:"+56 9 7045 6789", rating:4.3, totalTransportes:12 },
      { id:"demo-t5", nombre:"Rodrigo Vera",    empresa:"Fletes Cordillera SpA",      email:"rodrigo@cordillera.cl",  telefono:"+56 9 7056 7890", rating:4.7, totalTransportes:40 },
      { id:"demo-t6", nombre:"Camila Torres",   empresa:"Heavy Haul Chile",          email:"camila@heavyhaul.cl",    telefono:"+56 9 7067 8901", rating:4.5, totalTransportes:28 },
      { id:"demo-t7", nombre:"Sebastián Rojas", empresa:"Transportes Quilín",        email:"sebastian@quilin.cl",    telefono:"+56 9 7078 9012", rating:4.2, totalTransportes:9  },
      { id:"demo-t8", nombre:"Antonia Fuentes", empresa:"MaqTrans Biobío",           email:"antonia@maqtrans.cl",    telefono:"+56 9 7089 0123", rating:4.95, totalTransportes:61 }
    ];
    const pool=[];
    for(const t of transportistasReales){ if(pool.length>=8) break; pool.push({ id:t.id, nombre:t.nombre, empresa:t.empresa, email:t.email, telefono:t.telefono||"", rating:t.rating||5.0, totalTransportes:t.totalTransportes||0, real:true }); }
    for(const f of ficticios){ if(pool.length>=8) break; if(pool.some(p=>p.email===f.email)) continue; pool.push(f); }

    // 3. Plantillas de licitaciones
    const ahora=Date.now();
    const plantillas=[
      { tipoEquipo:"Motoniveladora", marca:"Komatsu GD555", origen:"Santiago", destino:"Calama",      tipoLicitacion:"maquinaria", peso:"18.000 kg", base:1900000 },
      { tipoEquipo:"Excavadora",     marca:"Caterpillar 320", origen:"Antofagasta", destino:"Iquique", tipoLicitacion:"maquinaria", peso:"22.000 kg", base:1450000 },
      { tipoEquipo:"Cargador frontal", marca:"Volvo L120", origen:"Concepción", destino:"Temuco",     tipoLicitacion:"maquinaria", peso:"16.500 kg", base:980000 },
      { tipoEquipo:"Carga general",  marca:"", origen:"Valparaíso", destino:"La Serena",               tipoLicitacion:"carga", tipoCarga:"Estructura metálica", peso:"12.000 kg", base:760000 }
    ];
    // estados según body.modo: 'variado' (default), 'abierta', 'cerrada'
    const modo=body.modo||"variado";
    const estadosPorIndice = modo==="abierta" ? ["abierta","abierta","abierta","abierta"]
      : modo==="cerrada" ? ["cerrada","cerrada","cerrada","cerrada"]
      : ["abierta","cerrada","adjudicada","pendiente_admin"];

    const creadas=[];
    for(let i=0;i<4;i++){
      const pl=plantillas[i];
      const id=uid(); const codigo=await generarCodigo(env,'LIC');
      const fechaCarga=new Date(ahora+(3+i)*86400000).toISOString().slice(0,10);
      const fechaEntregaBase=new Date(ahora+(5+i)*86400000);
      // Generar 8 cotizaciones variadas
      const cotizaciones=pool.map((t,j)=>{
        const precio=Math.round((pl.base*(0.9+(j*0.03)))/1000)*1000; // precios escalonados
        const diasEntrega=2+(j%4);
        const fEntrega=new Date(fechaEntregaBase.getTime()+ (j%4)*86400000);
        return {
          id:uid(), codigo:"COT-DEMO-"+(i+1)+"-"+(j+1), licitacionId:id,
          transportistaId:t.id, transportistaNombre:t.nombre, transportistaEmpresa:t.empresa,
          transportistaEmail:t.email, transportistaTelefono:t.telefono||"",
          transportistaRating:t.rating, transportistaTransportes:t.totalTransportes,
          precio:precio, tiempoEntrega:diasEntrega+" días", fechaCargaISO:fechaCarga,
          fechaEntregaISO:fEntrega.toISOString().slice(0,10),
          descripcion:"Servicio de transporte "+pl.tipoEquipo.toLowerCase()+" puerta a puerta.",
          incluye:["Seguro de carga","Permisos de circulación"], archivoId:null, archivoNombre:null,
          archivoPropioId:null, archivoPropioNombre:null,
          formulario:{ fechaEntrega:fEntrega.toISOString().slice(0,10), items:[{ descripcion:pl.tipoEquipo, cantidad:1, tarifa:precio, total:precio }], seguros:[{ tipo:"Carga", cobertura:"2000 UF" }] },
          tiempoRespuesta:10+j*5, score:0, createdAt:new Date(ahora - (8-j)*3600000).toISOString()
        };
      });

      const lic={
        id, codigo, clienteId:cliente.id, clienteEmail:cliente.email, clienteEmpresa:cliente.empresa||"",
        clienteNombre:cliente.nombre||"", clienteTelefono:cliente.telefono||"",
        empresaId:cliente.id, creadoPorEmail:cliente.email, creadoPorNombre:cliente.nombre||"", esCreadoPorSubusuario:false,
        tipoLicitacion:pl.tipoLicitacion, tipoEquipo:pl.tipoEquipo, tipoEquipoRequerido:"cualquiera",
        marca:pl.marca||"", tipoCarga:pl.tipoCarga||"", cantidadBultos:"", pesoPorBulto:"", peso:pl.peso||"",
        dimensiones:"", descripcion:"Solicitud de transporte de "+pl.tipoEquipo+" desde "+pl.origen+" a "+pl.destino+".",
        origen:pl.origen, destino:pl.destino, fechaCarga, fechaEntrega:fechaEntregaBase.toISOString().slice(0,10),
        plazo:"24", archivoId:null, archivoNombre:null,
        estado:estadosPorIndice[i], cotizaciones:cotizaciones, cotizacionesEnviadas:[], ronda:0,
        createdAt:new Date(ahora-12*3600000).toISOString(),
        cierreAt:new Date(ahora+12*3600000).toISOString(), _demo:true
      };

      // Rankear y aplicar según estado
      const precios=cotizaciones.map(c=>c.precio);
      const ranked=cotizaciones.map(c=>({ ...c, _allPrecios:precios, score:calcScore({ ...c, _allPrecios:precios }, fechaCarga) })).sort((a,b)=>b.score-a.score);
      lic.cotizaciones=ranked;
      if(lic.estado==="cerrada" || lic.estado==="adjudicada"){
        lic.cerradaAt=new Date(ahora-2*3600000).toISOString(); lic.ronda=1;
        lic.cotizacionesEnviadas=ranked.slice(0,3);
      }
      if(lic.estado==="adjudicada"){
        const ganadora=ranked[0];
        lic.adjudicadaA={ cotizacionId:ganadora.id, transportistaId:ganadora.transportistaId, transportistaEmpresa:ganadora.transportistaEmpresa, transportistaNombre:ganadora.transportistaNombre, transportistaEmail:ganadora.transportistaEmail, transportistaTelefono:ganadora.transportistaTelefono, precio:ganadora.precio, archivoPropioId:ganadora.archivoPropioId, archivoPropioNombre:ganadora.archivoPropioNombre };
        lic.adjudicadaAt=new Date(ahora-1*3600000).toISOString();
        // Crear transporte para la adjudicada
        const codigoTRN=await generarCodigo(env,"TRN"); const transporteId=uid();
        const transporte={ id:transporteId, codigo:codigoTRN, licitacionId:id, empresaId:cliente.id, creadoPorEmail:cliente.email, creadoPorNombre:cliente.nombre||'', licitacionCodigo:codigo, tipoEquipo:pl.tipoEquipo+(pl.marca?" - "+pl.marca:""), origen:pl.origen, destino:pl.destino, precio:ganadora.precio, clienteEmail:cliente.email, clienteEmpresa:cliente.empresa, clienteNombre:cliente.nombre||"", clienteTelefono:cliente.telefono||"", transportistaEmail:ganadora.transportistaEmail, transportistaNombre:ganadora.transportistaNombre, transportistaEmpresa:ganadora.transportistaEmpresa, transportistaTelefono:ganadora.transportistaTelefono||"", estado:"preparacion", estadoDocumentos:"pendiente", historial:[{ estado:"preparacion", nota:"Transporte creado al adjudicar", fecha:new Date().toISOString(), actor:"Sistema" }], oc:null, factura:null, adjudicadoAt:new Date().toISOString(), _demo:true };
        await env.RETORNOS.put("transporte:"+transporteId, JSON.stringify(transporte));
        const allT=JSON.parse(await env.RETORNOS.get("transportes:all")||"[]"); allT.unshift(transporteId); await env.RETORNOS.put("transportes:all", JSON.stringify(allT));
      }

      await env.LICITACIONES.put(id, JSON.stringify(lic));
      const idxC=JSON.parse(await env.LICITACIONES.get("cliente:"+cliente.id)||"[]"); idxC.unshift(id); await env.LICITACIONES.put("cliente:"+cliente.id, JSON.stringify(idxC));
      const idxA=JSON.parse(await env.LICITACIONES.get("all")||"[]"); idxA.unshift(id); await env.LICITACIONES.put("all", JSON.stringify(idxA));
      creadas.push({ codigo, estado:lic.estado, equipo:pl.tipoEquipo, cotizaciones:cotizaciones.length });
    }

    return ok({ ok:true, cliente:cliente.email, transportistasReales:transportistasReales.length, licitaciones:creadas });
  }

  // ── FIN SEED ────────────────────────────────────────────────
  if (path === "/api/conductores" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"transportista","admin"); if(d) return d;
    let email;
    if(user.role==="admin"){ email=url.searchParams.get("email")||user.email; }
    else { email=await emailEmpresaTransportista(env,user); } // conductores a nivel empresa
    const raw=await env.USERS.get(email); if(!raw) return err("No encontrado",404);
    return ok({ conductores:JSON.parse(raw).conductores||[] });
  }

  if (path === "/api/conductores" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.nombre||!body.rut) return err("Nombre y RUT son requeridos");
    const emailEmp=await emailEmpresaTransportista(env,user);
    const raw=await env.USERS.get(emailEmp); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw); if(!u.conductores) u.conductores=[];
    const conductor={
      id:uid(), nombre:body.nombre, rut:body.rut, telefono:body.telefono||"",
      carnetFrenteId:body.carnetFrenteId||null, carnetFrenteNombre:body.carnetFrenteNombre||null,
      carnetReversoId:body.carnetReversoId||null, carnetReversoNombre:body.carnetReversoNombre||null,
      licenciaFrenteId:body.licenciaFrenteId||null, licenciaFrenteNombre:body.licenciaFrenteNombre||null,
      licenciaReversoId:body.licenciaReversoId||null, licenciaReversoNombre:body.licenciaReversoNombre||null,
      createdAt:new Date().toISOString()
    };
    u.conductores.push(conductor);
    await env.USERS.put(emailEmp, JSON.stringify(u));
    return ok({ ok:true, id:conductor.id });
  }

  if (path.startsWith("/api/conductores/")&&path.split("/").length===4&&method==="DELETE") {
    const conductorId=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const emailEmp=await emailEmpresaTransportista(env,user);
    const raw=await env.USERS.get(emailEmp); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw); u.conductores=(u.conductores||[]).filter(c=>c.id!==conductorId);
    await env.USERS.put(emailEmp, JSON.stringify(u));
    return ok({ ok:true });
  }

  if (path === "/api/notificaciones" && method === "GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    const userId=user.role==="admin"?"admin":user.id;
    try {
      const ids=JSON.parse(await env.SESSIONS.get(`notifs:${userId}`)||"[]");
      const notificaciones=[];
      for(const nid of ids.slice(0,50)){ const raw=await env.SESSIONS.get(`notif:${userId}:${nid}`); if(raw) notificaciones.push(JSON.parse(raw)); }
      return ok({ notificaciones });
    } catch(e) { return ok({ notificaciones:[] }); }
  }

  if (path === "/api/notificaciones/leer" && method === "POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    let body={}; try{body=await request.json();}catch(e){}
    const userId=user.role==="admin"?"admin":user.id;
    if(body.todas){
      const ids=JSON.parse(await env.SESSIONS.get(`notifs:${userId}`)||"[]");
      for(const nid of ids){ const raw=await env.SESSIONS.get(`notif:${userId}:${nid}`); if(raw){ const n=JSON.parse(raw); n.leida=true; await env.SESSIONS.put(`notif:${userId}:${nid}`,JSON.stringify(n)); } }
    } else if(body.id){
      const raw=await env.SESSIONS.get(`notif:${userId}:${body.id}`); if(raw){ const n=JSON.parse(raw); n.leida=true; await env.SESSIONS.put(`notif:${userId}:${body.id}`, JSON.stringify(n)); }
    }
    return ok({ ok:true });
  }

  if (path === "/api/perfil/notificaciones" && method === "PUT") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const raw=await env.USERS.get(user.email); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw);
    if(body.notifEmail!==undefined) u.notifEmail=!!body.notifEmail;
    if(body.notifWhatsapp!==undefined) u.notifWhatsapp=!!body.notifWhatsapp;
    if(body.whatsapp!==undefined) u.whatsapp=body.whatsapp;
    if(body.telefono!==undefined) u.telefono=body.telefono;
    await env.USERS.put(user.email, JSON.stringify(u));
    return ok({ ok:true });
  }

  if (path === "/api/archivos/upload" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"cliente","transportista","admin"); if(d) return d;
    let body=null;
    try{ const text=await request.text(); if(!text||text.trim()==='') return err("Body vacio"); body=JSON.parse(text); }catch(e){return err("Formato invalido: "+e.message);}
    if(!body) return err("Body nulo");
    const nombre=body.nombre||null, tipo=body.tipo||null, base64=body.base64||null, licitacionId=body.licitacionId||null;
    if(!nombre||!base64) return err("nombre y base64 requeridos");
    if(base64.length>12000000) return err("Archivo demasiado grande. Maximo 8 MB");
    const ext=nombre.split('.').pop().toLowerCase();
    if(!['xlsx','xls','pdf','docx','doc','jpg','jpeg','png'].includes(ext)) return err("Tipo no permitido");
    const id=uid();
    await env.ARCHIVOS.put(id, JSON.stringify({ id, nombre, tipo, base64, licitacionId:licitacionId||null, subidoPor:user.id, subidoPorEmail:user.email, createdAt:new Date().toISOString() }));
    return ok({ ok:true, id, nombre });
  }

  if (path.startsWith("/api/archivos/")&&path.split("/").length===4&&method==="GET") {
    const id=path.split("/")[3]; const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    const raw=await env.ARCHIVOS.get(id); if(!raw) return err("No encontrado",404);
    const archivo=JSON.parse(raw);
    if(url.searchParams.get("info")==="1") return ok({ id:archivo.id, nombre:archivo.nombre, tipo:archivo.tipo, createdAt:archivo.createdAt });
    return ok({ id:archivo.id, nombre:archivo.nombre, tipo:archivo.tipo, base64:archivo.base64 });
  }

  // GET /api/admin/actividad — feed de actividad de toda la plataforma
  if (path === "/api/admin/actividad" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const feed = JSON.parse(await env.SESSIONS.get("actividad:index") || "[]");
    return ok({ actividad: feed.slice(0,50) });
  }

  if (path === "/api/admin/stats" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;

    // Leer índices en paralelo
    const [idsRaw, ovIdsRaw] = await Promise.all([
      env.LICITACIONES.get("all"),
      env.OVS.get("ovs:all")
    ]);
    const ids   = JSON.parse(idsRaw   || "[]");
    const ovIds = JSON.parse(ovIdsRaw || "[]");

    // Leer todas las licitaciones en paralelo (max 150)
    const licitRaws = await Promise.all(ids.slice(0,150).map(id => env.LICITACIONES.get(id)));
    let pendiente_admin=0,abiertas=0,cerradas=0,adjudicadas=0,completadas=0;
    for(const raw of licitRaws){
      if(!raw) continue;
      const l=JSON.parse(raw);
      if(l.estado==="pendiente_admin") pendiente_admin++;
      else if(l.estado==="abierta")    abiertas++;
      else if(l.estado==="cerrada")    cerradas++;
      else if(l.estado==="adjudicada") adjudicadas++;
      else if(l.estado==="completada") completadas++;
    }

    // Leer todas las OVs en paralelo (max 300)
    const ovRaws = await Promise.all(ovIds.slice(0,300).map(id => env.OVS.get("ov:"+id)));
    let ovCondicionales=0,ovConfirmadas=0,ovFacturadas=0,comisionPendiente=0,comisionFacturada=0;
    for(const raw of ovRaws){
      if(!raw) continue;
      const ov=JSON.parse(raw);
      if(ov.estado==="CONDICIONAL") ovCondicionales++;
      else if(ov.estado==="CONFIRMADA"){ ovConfirmadas++; comisionPendiente+=(ov.comision_final||0); }
      else if(ov.estado==="FACTURADA"){  ovFacturadas++;  comisionFacturada+=(ov.comision_final||0); }
    }

    // Alertas: transportistas pendientes de aprobación
    const alertas = [];
    const usersLista = await env.USERS.list();
    for(const key of usersLista.keys){
      if(key.name.startsWith("id:")) continue;
      const raw = await env.USERS.get(key.name);
      if(!raw) continue;
      const u = JSON.parse(raw);
      if(u.role==="transportista" && u.estado==="pendiente"){
        alertas.push({ tipo:"transportista_pendiente", nombre:u.nombre, empresa:u.empresa, email:u.email, createdAt:u.createdAt });
      }
    }

    return ok({ total:ids.length, pendiente_admin, abiertas, cerradas, adjudicadas, completadas, ovCondicionales, ovConfirmadas, ovFacturadas, comisionPendiente, comisionFacturada, alertas });
  }

  // POST /api/admin/equipos-pendientes — aprobar o rechazar equipo tipo "Otro"
  if (path === "/api/admin/equipos-pendientes" && method === "POST") {
    const user = await getUser(request, env); const d = deny(user, "admin"); if(d) return d;
    let b = {}; try{ b = await request.json(); }catch(e){ return err("Formato invalido"); }
    const { accion, emailTransportista, equipoTexto } = b;
    if(!accion||!emailTransportista) return err("Faltan campos");
    try{
      // Actualizar lista de equipos pendientes en SESSIONS
      const pendientes = JSON.parse(await env.SESSIONS.get("equipos:pendientes") || "[]");
      const idx = pendientes.findIndex(p => p.email === emailTransportista);
      if(idx !== -1){
        if(accion === "aprobar"){
          pendientes[idx].estado = "aprobado";
          pendientes[idx].textoFinal = equipoTexto;
          // Agregar al perfil del transportista como tipoEquipo aprobado
          const rawUser = await env.USERS.get(emailTransportista);
          if(rawUser){
            const u = JSON.parse(rawUser);
            if(!u.tiposEquipo) u.tiposEquipo = [];
            if(!u.tiposEquipo.includes(equipoTexto)) u.tiposEquipo.push(equipoTexto);
            u.otroEquipoPendiente = null;
            await env.USERS.put(emailTransportista, JSON.stringify(u));
          }
          // Notificar al transportista
          await crearNotificacion(env, emailTransportista.replace('@','_').replace('.','_'), "equipo_aprobado",
            `Tu equipo "${equipoTexto}" fue aprobado y agregado al listado de TransMatch.`, {});
        } else {
          pendientes[idx].estado = "rechazado";
        }
        await env.SESSIONS.put("equipos:pendientes", JSON.stringify(pendientes));
      }
      return ok({ ok: true });
    } catch(e){ return err("Error: " + e.message, 500); }
  }

  if (path === "/api/admin/transportistas-pendientes" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const lista=await env.USERS.list(); const pendientes=[];
    for(const key of lista.keys){ if(key.name.startsWith("id:")) continue; const raw=await env.USERS.get(key.name); if(!raw) continue; const u=JSON.parse(raw); if(u.role==="transportista"&&u.estado==="pendiente") pendientes.push({ id:u.id,nombre:u.nombre,empresa:u.empresa,email:u.email,createdAt:u.createdAt }); }
    return ok({ pendientes });
  }

  if (path === "/api/admin/aprobar-transportista" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { email, accion } = body; if(!email||!accion) return err("email y accion requeridos");
    const raw=await env.USERS.get(email.toLowerCase()); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw); u.estado=accion==="aprobar"?"activo":"rechazado"; u.revisadoAt=new Date().toISOString();
    await env.USERS.put(email.toLowerCase(), JSON.stringify(u));
    if(accion==="aprobar"){ await crearNotificacion(env,u.id,"cuenta_aprobada","Tu cuenta fue aprobada! Ya puedes ver licitaciones y cotizar.",{}); await enviarEmail(env,{ to:u.email, subject:"Tu cuenta TransMatch fue aprobada", html:emailCuentaAprobada(u.nombre) }); await registrarActividad(env,"transportista_aprobado",`Transportista aprobado: ${u.empresa||u.nombre}`,{ transportistaId:u.id }); }
    return ok({ ok:true });
  }





  // ── CONTACTO: formulario público (sin auth) + Resend ──
  if (path === "/api/contacto" && method === "POST") {
    let body = {}; try { body = await request.json(); } catch(e) {}
    const { nombre, empresa, email, telefono, tipo } = body;
    if (!nombre || !empresa || !email || !telefono || !tipo) {
      return err("Todos los campos son obligatorios");
    }

    const tipoLabel = tipo === 'mandante' ? 'Mandante (empresa que requiere transporte)' : 'Transportista (empresa de transporte)';

    // Email al equipo TransMatch
    const htmlEquipo = `
      <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto">
        <div style="background:#1e2d4e;padding:20px 28px;border-radius:10px 10px 0 0">
          <span style="font-size:20px;font-weight:700;color:#fff">Trans<span style="color:#ff8904">Match</span></span>
        </div>
        <div style="background:#f5f7fb;padding:28px;border-radius:0 0 10px 10px;border:1px solid #e8eaf0">
          <h2 style="color:#1e2d4e;margin:0 0 20px">Nueva solicitud de contacto</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 0;color:#6B7280;width:120px">Nombre</td><td style="padding:8px 0;color:#111827;font-weight:500">${nombre}</td></tr>
            <tr><td style="padding:8px 0;color:#6B7280">Empresa</td><td style="padding:8px 0;color:#111827;font-weight:500">${empresa}</td></tr>
            <tr><td style="padding:8px 0;color:#6B7280">Email</td><td style="padding:8px 0;color:#1d4ed8">${email}</td></tr>
            <tr><td style="padding:8px 0;color:#6B7280">Teléfono</td><td style="padding:8px 0;color:#111827;font-weight:500">${telefono}</td></tr>
            <tr><td style="padding:8px 0;color:#6B7280">Tipo</td><td style="padding:8px 0"><span style="background:#FFF7ED;color:#92400E;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${tipoLabel}</span></td></tr>
          </table>
        </div>
      </div>`;

    // Email de confirmación al solicitante
    const htmlConfirm = `
      <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto">
        <div style="background:#1e2d4e;padding:20px 28px;border-radius:10px 10px 0 0">
          <span style="font-size:20px;font-weight:700;color:#fff">Trans<span style="color:#ff8904">Match</span></span>
        </div>
        <div style="background:#fff;padding:32px;border-radius:0 0 10px 10px;border:1px solid #e8eaf0">
          <h2 style="color:#1e2d4e;margin:0 0 12px">Hola ${nombre},</h2>
          <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px">Recibimos tu solicitud. En breve nos pondremos en contacto contigo para coordinar la cotización correspondiente a <strong>${empresa}</strong>.</p>
          <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 24px">Si tienes alguna consulta urgente, puedes escribirnos directamente a <a href="mailto:contacto@transmatch.cl" style="color:#ff8904">contacto@transmatch.cl</a>.</p>
          <p style="color:#6B7280;font-size:13px;margin:0">El equipo TransMatch</p>
        </div>
      </div>`;

    try {
      const RESEND_KEY = env.RESEND_API_KEY;
      // Email al equipo
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "TransMatch <contacto@transmatch.cl>",
          to: ["contacto@transmatch.cl"],
          reply_to: email,
          subject: "Nueva solicitud de contacto — " + nombre + " / " + empresa,
          html: htmlEquipo
        })
      });
      // Confirmación al solicitante
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "TransMatch <contacto@transmatch.cl>",
          to: [email],
          subject: "Recibimos tu solicitud — TransMatch",
          html: htmlConfirm
        })
      });
    } catch(e) {
      // Si falla Resend, igual guardamos y retornamos OK
    }

    // Guardar en KV como respaldo
    const contactId = uid();
    await env.SESSIONS.put("contacto:" + contactId, JSON.stringify({
      id: contactId, nombre, empresa, email, telefono, tipo,
      createdAt: new Date().toISOString()
    }));

    return ok({ ok: true, mensaje: "Solicitud recibida. Te contactaremos pronto." });
  }

  // ── COBROS: generar cobro 4% desde licitación adjudicada ──
  if (path === "/api/cobros/generar" && method === "POST") {
    const user = await getUser(request, env);
    const d = deny(user, "admin");
    if (d) return d;
    let body = {}; try { body = await request.json(); } catch(e) {}
    const { licitacionId } = body;
    if (!licitacionId) return err("licitacionId requerido");
    const raw = await env.LICITACIONES.get(licitacionId);
    if (!raw) return err("Licitación no encontrada", 404);
    const l = JSON.parse(raw);
    if (l.estado !== "adjudicada") return err("La licitación no está adjudicada");
    const cotiz = (l.cotizaciones || []).find(c => l.adjudicadaA && c.id === l.adjudicadaA.cotizacionId);
    if (!cotiz) return err("Cotización adjudicada no encontrada");
    const fee = Math.round(cotiz.precio * 0.04);
    const ovId = await generarCodigoOV(env);
    const ov = {
      id_ov: ovId, licitacionId, transportistaId: cotiz.transportistaId,
      transportistaEmail: cotiz.transportistaEmail, transportistaNombre: cotiz.transportistaNombre,
      transportistaEmpresa: cotiz.transportistaEmpresa, clienteEmpresa: l.clienteEmpresa,
      precio_flete: cotiz.precio, comision_porcentaje: 0.04, comision_final: fee,
      estado: "CONDICIONAL", createdAt: new Date().toISOString()
    };
    await env.OVS.put("ov:" + ovId, JSON.stringify(ov));
    const ovIds = JSON.parse(await env.OVS.get("ovs:all") || "[]");
    ovIds.unshift(ovId);
    await env.OVS.put("ovs:all", JSON.stringify(ovIds));
    l.cobro = { ovId, fee };
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    return ok({ cobro: { ovId, fee } });
  }

  // ── INVITACIÓN: validar token de invitación (registro transportista) ──
  if (path.startsWith("/api/invitacion/") && method === "GET") {
    const token = path.split("/")[3];
    if (!token) return err("Token requerido");
    const raw = await env.SESSIONS.get("invitacion:" + token);
    if (!raw) return err("Invitación inválida o expirada", 404);
    const inv = JSON.parse(raw);
    if (inv.usada) return err("Invitación ya utilizada", 410);
    return ok({ valida: true, email: inv.email, nombre: inv.nombre });
  }

  // ── MI EMPRESA: editar usuario dentro de empresa (perfil cliente/transportista) ──
  if (path.startsWith("/api/mi-empresa/usuario/") && method === "PUT") {
    const user = await getUser(request, env);
    if (!user) return err("No autenticado", 401);
    const emailTarget = decodeURIComponent(path.split("/")[4]);
    // Solo puede editar su propia cuenta o admin edita cualquiera
    if (user.role !== "admin" && user.email !== emailTarget) return err("Sin acceso", 403);
    let body = {}; try { body = await request.json(); } catch(e) {}
    const raw = await env.USERS.get(emailTarget.toLowerCase());
    if (!raw) return err("Usuario no encontrado", 404);
    const u = JSON.parse(raw);
    // Campos editables
    if (body.nombre    !== undefined) u.nombre    = body.nombre;
    if (body.telefono  !== undefined) u.telefono  = body.telefono;
    if (body.empresa   !== undefined) u.empresa   = body.empresa;
    if (body.rut       !== undefined) u.rut       = body.rut;
    if (body.direccion !== undefined) u.direccion = body.direccion;
    if (body.ciudad    !== undefined) u.ciudad    = body.ciudad;
    u.updatedAt = new Date().toISOString();
    await env.USERS.put(emailTarget.toLowerCase(), JSON.stringify(u));
    return ok({ ok: true, usuario: { nombre: u.nombre, empresa: u.empresa, telefono: u.telefono, rut: u.rut } });
  }

  // ── RESET: borrar todos los datos excepto cuenta admin ──
  if (path === "/api/admin/reset-datos" && method === "POST") {
    const user = await getUser(request, env);
    const d = deny(user, "admin");
    if (d) return d;

    let borrados = { usuarios:0, licitaciones:0, transportes:0, ovs:0, archivos:0, notificaciones:0, retornos:0 };

    // 1. USUARIOS — borrar todos menos el admin
    try {
      const lista = await env.USERS.list();
      for (const key of lista.keys) {
        if (key.name.startsWith("id:")) continue; // índices internos
        const raw = await env.USERS.get(key.name);
        if (!raw) continue;
        const u = JSON.parse(raw);
        if (u.role === "admin") continue; // conservar admin
        await env.USERS.delete(key.name);
        borrados.usuarios++;
      }
    } catch(e) {}

    // 2. LICITACIONES — borrar todas
    try {
      const ids = JSON.parse(await env.LICITACIONES.get("all") || "[]");
      for (const id of ids) {
        await env.LICITACIONES.delete(id);
        borrados.licitaciones++;
      }
      await env.LICITACIONES.put("all", "[]");
    } catch(e) {}

    // 3. TRANSPORTES y RETORNOS
    try {
      const tIds = JSON.parse(await env.RETORNOS.get("transportes:all") || "[]");
      for (const id of tIds) {
        await env.RETORNOS.delete("transporte:" + id);
        borrados.transportes++;
      }
      await env.RETORNOS.put("transportes:all", "[]");

      // Retornos
      const rIds = JSON.parse(await env.RETORNOS.get("all") || "[]");
      for (const id of rIds) {
        await env.RETORNOS.delete(id);
        borrados.retornos++;
      }
      await env.RETORNOS.put("all", "[]");
    } catch(e) {}

    // 4. OVs (órdenes de venta y facturas)
    try {
      const ovIds = JSON.parse(await env.OVS.get("ovs:all") || "[]");
      for (const id of ovIds) {
        await env.OVS.delete("ov:" + id);
        borrados.ovs++;
      }
      await env.OVS.put("ovs:all", "[]");

      // Facturas mensuales
      const facIds = JSON.parse(await env.OVS.get("facturas:all") || "[]");
      for (const id of facIds) { await env.OVS.delete("factura:" + id); }
      await env.OVS.put("facturas:all", "[]");
    } catch(e) {}

    // 5. Archivos
    try {
      const archList = await env.ARCHIVOS.list();
      for (const key of archList.keys) {
        await env.ARCHIVOS.delete(key.name);
        borrados.archivos++;
      }
    } catch(e) {}

    // 6. Notificaciones (en SESSIONS)
    try {
      const sessList = await env.SESSIONS.list();
      for (const key of sessList.keys) {
        if (key.name.startsWith("notif:") || key.name.startsWith("notifs:")) {
          await env.SESSIONS.delete(key.name);
          borrados.notificaciones++;
        }
      }
    } catch(e) {}

    // 7. Resetear contadores de códigos
    try {
      await env.SESSIONS.put("contador:LIC", "0");
      await env.SESSIONS.put("contador:COT", "0");
      await env.SESSIONS.put("contador:TRN", "0");
      await env.SESSIONS.put("contador:OV",  "0");
    } catch(e) {}

    return ok({
      mensaje: "Reset completado. Cuenta admin conservada.",
      borrados
    });
  }


  // ── MIGRAR sub-usuarios: agregar empresaMadreId a los que no lo tienen ──
  if (path === "/api/admin/migrar-subusuarios" && method === "POST") {
    const user = await getUser(request, env);
    const d = deny(user, "admin"); if(d) return d;
    let migrados = 0, errores = 0;
    const lista = await env.USERS.list();
    for (const key of lista.keys) {
      if (key.name.startsWith("id:")) continue;
      const raw = await env.USERS.get(key.name);
      if (!raw) continue;
      const u = JSON.parse(raw);
      // Solo sub-usuarios sin empresaMadreId
      if (!u.esSubusuario || u.empresaMadreId) continue;
      // Buscar cuenta madre por empresaAdminEmail
      if (!u.empresaAdminEmail) continue;
      const rawMadre = await env.USERS.get(u.empresaAdminEmail);
      if (!rawMadre) continue;
      const madre = JSON.parse(rawMadre);
      u.empresaMadreId = madre.id;
      await env.USERS.put(key.name, JSON.stringify(u));
      migrados++;
    }
    return ok({ mensaje: "Migración completada", migrados, errores });
  }

  // ── MIGRACIÓN: asignar códigos a licitaciones y cotizaciones existentes ──
  if (path === "/api/admin/migrar-codigos" && method === "POST") {
    const user = await getUser(request, env);
    const d = deny(user, "admin");
    if (d) return d;

    const allIds = JSON.parse(await env.LICITACIONES.get("all") || "[]");
    let licitMigradas = 0, cotizMigradas = 0, errores = 0;

    for (const id of allIds) {
      try {
        const raw = await env.LICITACIONES.get(id);
        if (!raw) continue;
        const l = JSON.parse(raw);
        let modified = false;

        // Asignar código a licitación si no tiene
        if (!l.codigo) {
          l.codigo = await generarCodigo(env, 'LIC');
          modified = true;
          licitMigradas++;
        }

        // Asignar código a cada cotización si no tiene
        if (l.cotizaciones && l.cotizaciones.length > 0) {
          for (let i = 0; i < l.cotizaciones.length; i++) {
            if (!l.cotizaciones[i].codigo) {
              l.cotizaciones[i].codigo = await generarCodigo(env, 'COT');
              modified = true;
              cotizMigradas++;
            }
          }
        }

        if (modified) {
          await env.LICITACIONES.put(id, JSON.stringify(l));
        }
      } catch(e) {
        errores++;
      }
    }

    return ok({
      mensaje: "Migración completada",
      licitacionesMigradas: licitMigradas,
      cotizacionesMigradas: cotizMigradas,
      errores
    });
  }

  if (path === "/api/admin/usuarios" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const lista=await env.USERS.list(); const usuarios=[];
    const madreCache={};
    for(const key of lista.keys){
      if(key.name.startsWith("id:")) continue;
      const raw=await env.USERS.get(key.name); if(!raw) continue;
      const u=JSON.parse(raw);
      let rutEmpresaOut=u.rutEmpresa||'', giroOut=u.giro||'', direccionOut=u.direccion||'', telEmpresaOut=u.telEmpresa||'', ciudadEmpresaOut=u.ciudadEmpresa||'', webOut=u.web||'', descripcionOut=u.descripcion||'';
      if(u.esSubusuario && u.empresaMadreId){
        let m=madreCache[u.empresaMadreId];
        if(m===undefined){
          m=null;
          const mEmail=await env.USERS.get("id:"+u.empresaMadreId);
          if(mEmail){ const rawM=await env.USERS.get(mEmail); if(rawM) m=JSON.parse(rawM); }
          madreCache[u.empresaMadreId]=m;
        }
        if(m){
          rutEmpresaOut=m.rutEmpresa||rutEmpresaOut;
          giroOut=m.giro||giroOut;
          direccionOut=m.direccion||direccionOut;
          telEmpresaOut=m.telEmpresa||telEmpresaOut;
          ciudadEmpresaOut=m.ciudadEmpresa||ciudadEmpresaOut;
          webOut=m.web||webOut;
          descripcionOut=m.descripcion||descripcionOut;
        }
      }
      usuarios.push({ id:u.id,email:u.email,nombre:u.nombre,empresa:u.empresa,role:u.role,estado:u.estado,plan:u.plan,createdAt:u.createdAt,rating:u.rating,totalTransportes:u.totalTransportes,telefono:u.telefono||'',rut:u.rut||'',cargo:u.cargo||'',rutEmpresa:rutEmpresaOut,giro:giroOut,direccion:direccionOut,telEmpresa:telEmpresaOut,ciudadEmpresa:ciudadEmpresaOut,web:webOut,descripcion:descripcionOut,max_usuarios:u.max_usuarios||0,empresaMiembros:u.empresaMiembros||[],esSubusuario:u.esSubusuario||false,empresaMadreId:u.empresaMadreId||null,desactivadoManual:u.desactivadoManual||false,notasAdmin:u.notasAdmin||'',equipos:u.equipos||[],tiposEquipo:u.tiposEquipo||[],zonas:u.zonas||[],rutRepresentante:u.rutRepresentante||'',ciudad:u.ciudad||'',whatsapp:u.whatsapp||'',industrias:u.industrias||[],anosExperiencia:u.anosExperiencia||'',perfilCompletitud:u.perfilCompletitud||0,totalCotizaciones:u.totalCotizaciones||0,facturacion:u.facturacion||null,contactoOperaciones:u.contactoOperaciones||null,contactoComercial:u.contactoComercial||null,contactoFacturacion:u.contactoFacturacion||null,contactos:u.contactos||[],datosBancarios:u.datosBancarios||null,notifEmail:u.notifEmail||false,notifWhatsapp:u.notifWhatsapp||false });
    }
    return ok({ usuarios });
  }

  if (path === "/api/admin/gestionar-usuario" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { email, estado, plan, notasAdmin } = body; if(!email) return err("email requerido");
    const raw=await env.USERS.get(email.toLowerCase()); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw);
    if(notasAdmin!==undefined) u.notasAdmin=notasAdmin;
    if(estado) u.estado=estado;
    if(plan&&["basico","pro","enterprise"].includes(plan)) u.plan=plan;
    if(body.max_usuarios!==undefined) u.max_usuarios=parseInt(body.max_usuarios)||0;
    await env.USERS.put(email.toLowerCase(), JSON.stringify(u));
    return ok({ ok:true });
  }

  // Activar/desactivar manualmente un sub-usuario (independiente de la cascada de la madre)
  if (path === "/api/admin/subusuario-activacion" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { email, activo } = body; if(!email||activo===undefined) return err("email y activo requeridos");
    const raw=await env.USERS.get(email.toLowerCase()); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw);
    if(!u.esSubusuario) return err("Solo aplica a sub-usuarios",400);
    u.desactivadoManual = !activo;
    await env.USERS.put(email.toLowerCase(), JSON.stringify(u));
    return ok({ ok:true, desactivadoManual:u.desactivadoManual });
  }

  if (path.startsWith('/api/admin/usuario/')&&method==='DELETE') {
    const user=await getUser(request,env); if(!user||user.role!=='admin') return err('No autorizado',403);
    const emailToDelete=decodeURIComponent(path.replace('/api/admin/usuario/',''));
    if(!emailToDelete) return err('Email requerido');
    await env.USERS.delete(emailToDelete.toLowerCase());
    return ok({ message:'Usuario eliminado' });
  }

  if (path === "/api/perfil" && method === "PUT") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const raw=await env.USERS.get(user.email); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw);
    for(const k of ["nombre","empresa","telefono","rut","direccion","whatsapp","ciudad","giro","web","descripcion","anosExperiencia","zonas","equipos","tiposEquipo","genera_oc_propia","rutEmpresa","cargo","industrias","telEmpresa","ciudadEmpresa","facturacion","contactoOperaciones","contactoComercial","contactoFacturacion","contactos","datosBancarios"]){ if(body[k]!==undefined) u[k]=body[k]; }
    // Recalcular completitud automáticamente
    if(u.role==='cliente'){
      let pts=0;
      if(u.nombre)pts+=8;if(u.empresa)pts+=8;if(u.rutEmpresa)pts+=6;if(u.cargo)pts+=6;if(u.telefono)pts+=6;if(u.email)pts+=6;
      if(u.giro)pts+=5;if(u.direccion)pts+=5;if(u.ciudad||u.ciudadEmpresa)pts+=5;if(u.descripcion)pts+=5;
      const f=u.facturacion||{};
      if(f.razonSocial||u.empresa)pts+=6;if(f.rut||u.rutEmpresa)pts+=6;if(f.giro)pts+=6;if(f.email)pts+=6;if(f.contactoNombre)pts+=6;
      u.perfilCompletitud=Math.min(100,pts);
    } else if(u.role==='transportista'){
      let pts=0;
      if(u.nombre)pts+=5;if(u.empresa)pts+=5;if(u.rutEmpresa)pts+=5;if(u.cargo)pts+=5;if(u.telefono)pts+=5;if(u.email)pts+=5;
      if(u.zonas&&u.zonas.length)pts+=5;if(u.tiposEquipo&&u.tiposEquipo.length)pts+=5;
      if(u.giro)pts+=3;if(u.direccion)pts+=3;if(u.ciudad)pts+=3;if(u.descripcion)pts+=3;
      if((u.contactos&&u.contactos.length)||u.contactoOperaciones||u.contactoComercial)pts+=8;if(u.contactoFacturacion)pts+=3;
      if(u.datosBancarios&&u.datosBancarios.numeroCuenta)pts+=4;
      const eqs=u.equipos||[];if(eqs.length>0)pts+=10;
      const conDocs=eqs.filter(e=>{const d=e.documentos||{};return Object.keys(d).length>=3;});if(conDocs.length>0)pts+=10;
      u.perfilCompletitud=Math.min(100,pts);
    }
    u.updatedAt=new Date().toISOString();
    await env.USERS.put(user.email, JSON.stringify(u));
    return ok({ ok:true });
  }

  if (path === "/api/transportes" && method === "GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    const emailsT = user.role==="transportista" ? await emailsEmpresa(env, user) : null;
    const allIds=JSON.parse(await env.RETORNOS.get("transportes:all")||"[]"); const transportes=[];
    for(const id of allIds){ const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) continue; const t=JSON.parse(raw); if(user.role==="admin"){ transportes.push(t); continue; } if(user.role==="cliente"){ const miEmpId=user.esSubusuario?(user.empresaMadreId||user.id):user.id; if((t.empresaId||t.clienteId)===miEmpId) transportes.push(filtrarIncidenciasPorRol(t,user.role)); } if(user.role==="transportista"&&t.transportistaEmail&&emailsT.has(t.transportistaEmail.toLowerCase())){ const asignado=asignadoDeTransporte(t); t.asignadoNombre=t.asignadoNombre||t.transportistaNombre||""; t.puedoGestionar=(asignado===user.email.toLowerCase())||(!user.esSubusuario); transportes.push(filtrarIncidenciasPorRol(t,user.role)); } }
    return ok({ transportes });
  }

  if (path.match(/^\/api\/transportes\/[^/]+$/)&&method==="GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    const id=path.split("/").pop(); const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw);
    if(!(await puedeVerTransporte(env,user,t))) return err("Sin acceso",403);
    if(user.role==="transportista"){
      t.asignadoNombre=t.asignadoNombre||t.transportistaNombre||"";
      t.puedoGestionar=await puedeGestionarTransporte(env,user,t);
      // Miembros de la empresa para el selector de "ceder" (solo si puede gestionar)
      if(t.puedoGestionar){
        const emails=await emailsEmpresa(env,user); const miembros=[];
        for(const em of emails){ const r=await env.USERS.get(em); if(!r) continue; const mu=JSON.parse(r); miembros.push({ email:mu.email, nombre:mu.nombre||mu.email, esMadre:!mu.esSubusuario }); }
        t.miembrosEmpresa=miembros;
        t.asignadoEmailActual=asignadoDeTransporte(t);
      }
    }
    return ok({ transporte:filtrarIncidenciasPorRol(t,user.role) });
  }

  if (path.match(/^\/api\/transportes\/[^/]+\/estado$/)&&method==="POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){}
    const { estado, nota } = body;
    if(!["preparacion","en_ruta","carga_recogida","en_destino","entregado"].includes(estado)) return err("Estado invalido");
    t.estado=estado; t.historial=t.historial||[]; t.historial.push({ estado, nota:nota||"", fecha:new Date().toISOString(), actor:user.nombre||user.email });
    if(estado==="entregado") t.entregadoAt=new Date().toISOString();
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true, estado });
  }

  // POST /api/transportes/:id/ceder — ceder la gestión del transporte a otro miembro de la empresa
  if (path.match(/^\/api\/transportes\/[^/]+\/ceder$/)&&method==="POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw);
    if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const nuevoEmail=(body.email||"").toLowerCase().trim(); if(!nuevoEmail) return err("email requerido");
    // El destinatario debe pertenecer a la misma empresa
    const emails=await emailsEmpresa(env,user);
    if(!emails.has(nuevoEmail)) return err("El usuario no pertenece a tu empresa",400);
    const rawNuevo=await env.USERS.get(nuevoEmail); if(!rawNuevo) return err("Usuario no encontrado",404);
    const nuevo=JSON.parse(rawNuevo);
    t.asignadoEmail=nuevo.email; t.asignadoId=nuevo.id; t.asignadoNombre=nuevo.nombre||nuevo.email;
    t.historial=t.historial||[]; t.historial.push({ estado:t.estado, fecha:new Date().toISOString(), actor:user.nombre||user.email, nota:"Adjudicación cedida a "+(nuevo.nombre||nuevo.email) });
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    if(nuevo.id) await crearNotificacion(env, nuevo.id, "transporte_cedido", `Te cedieron la gestión del transporte ${t.codigo||""}.`, { transporteId:id });
    return ok({ ok:true, asignadoNombre:t.asignadoNombre });
  }

  // POST /api/transportes/:id/valoracion/responder — el transportista responde públicamente a una valoración.
  // La nota (promedio/scores) NUNCA se modifica — solo se agrega una respuesta visible junto a la valoración,
  // para dar contexto sin permitir que el rating se "negocie" apelación por apelación.
  if (path.match(/^\/api\/transportes\/[^/]+\/valoracion\/responder$/)&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw);
    if(!(await puedeVerTransporte(env,user,t))) return err("Sin acceso",403);
    if(!t.valoracion) return err("Este transporte todavía no tiene valoración");
    if(t.valoracion.respuestaTransportista) return err("Ya respondiste esta valoración");
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.respuesta||!body.respuesta.trim()) return err("Escribe tu respuesta");
    const respuesta=body.respuesta.trim().slice(0,500);
    t.valoracion.respuestaTransportista=respuesta;
    t.valoracion.respuestaTransportistaAt=new Date().toISOString();
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    // Reflejar lo mismo en la licitación, donde se guarda una copia de la valoración
    if(t.licitacionId){
      const rawL=await env.LICITACIONES.get(t.licitacionId);
      if(rawL){ const l=JSON.parse(rawL); if(l.valoracion){ l.valoracion.respuestaTransportista=respuesta; l.valoracion.respuestaTransportistaAt=t.valoracion.respuestaTransportistaAt; await env.LICITACIONES.put(t.licitacionId, JSON.stringify(l)); } }
    }
    await registrarActividad(env,"valoracion_respondida",`Transportista respondió a una valoración`,{ transporteId:id });
    return ok({ ok:true });
  }

  // POST /api/transportes/:id/incidencia — reporte interno de incidencia (Cliente <-> Transportista).
  // Solo lo ve TransMatch (admin) y quien lo reportó. NUNCA se notifica a la contraparte.
  // No es un mecanismo de mediación/arbitraje entre las partes: es un registro para control de calidad interno,
  // que TransMatch puede usar para decidir si suspende o no a un usuario (Cláusula 11 de los T&C).
  if (path.match(/^\/api\/transportes\/[^/]+\/incidencia$/)&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"cliente","transportista"); if(d) return d;
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw);
    if(!(await puedeVerTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.tipo) return err("Selecciona una categoría");
    if(!body.descripcion||!body.descripcion.trim()) return err("Describe brevemente lo ocurrido");
    const incidencia={ id:crypto.randomUUID(), tipo:body.tipo, descripcion:body.descripcion.trim(), archivoId:body.archivoId||null, archivoNombre:body.archivoNombre||null, reportadoPorNombre:user.nombre||"", reportadoPorEmail:user.email||"", reportadoPorEmpresa:user.empresa||"", createdAt:new Date().toISOString() };
    if(user.role==="cliente"){ t.incidenciasCliente=t.incidenciasCliente||[]; t.incidenciasCliente.push(incidencia); }
    else{ t.incidenciasTransportista=t.incidenciasTransportista||[]; t.incidenciasTransportista.push(incidencia); }
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    // Aviso interno a TransMatch — nunca se notifica a la contraparte
    try{ await crearNotificacion(env,"admin","incidencia_reportada",`Incidencia reportada por ${user.role} (${user.email}) sobre transporte ${t.codigo||id}: ${body.tipo}`,{ transporteId:id }); }catch(e){}
    await registrarActividad(env,"incidencia_reportada",`Incidencia reportada por ${user.role}: ${body.tipo}`,{ transporteId:id, role:user.role });
    return ok({ ok:true, incidencia });
  }

  if (path.match(/^\/api\/transportes\/[^/]+\/subir-oc$/)&&method==="POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="cliente") return err("Solo clientes",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if((t.empresaId||t.clienteId)!==(user.esSubusuario?(user.empresaMadreId||user.id):user.id)) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.base64) return err("Archivo requerido");
    const archivoId=uid(); await env.ARCHIVOS.put(archivoId, JSON.stringify({ base64:body.base64, mimeType:body.mimeType, nombre:body.nombre, createdAt:new Date().toISOString() }));
    t.oc={ archivoId, nombre:body.nombre||"orden_de_compra.pdf", subidoAt:new Date().toISOString(), subidoPor:"cliente" };
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    await crearNotificacion(env, t.transportistaId||"", "oc_disponible", "El Cliente ha subido la Orden de Compra.", { transporteId:id });
    return ok({ ok:true, archivoId });
  }

  if (path.match(/^\/api\/transportes\/[^/]+\/subir-factura$/)&&method==="POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.base64) return err("Archivo requerido");
    const archivoId=uid();
    await env.ARCHIVOS.put(archivoId, JSON.stringify({ base64:body.base64, mimeType:body.mimeType, nombre:body.nombre, createdAt:new Date().toISOString() }));
    t.factura={ archivoId, nombre:body.nombre||"factura.pdf", subidoAt:new Date().toISOString() };
    t.estado="completado"; t.completadoAt=new Date().toISOString(); t.estadoDocumentos="completo";
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    await crearNotificacion(env, t.clienteId||"", "factura_disponible", "La factura de tu transporte esta lista.", { transporteId:id });
    const ovIds=JSON.parse(await env.OVS.get("ovs:all")||"[]");
    for(const ovId of ovIds){
      const rawOV=await env.OVS.get("ov:"+ovId); if(!rawOV) continue;
      const ov=JSON.parse(rawOV);
      if(ov.id_transporte!==id) continue;
      if(ov.estado!=="CONDICIONAL") continue;
      const valorFactura=parseFloat(body.valorFactura||t.precio||0);
      const valorUF=await obtenerUF();
      const comisionFinal=calcularComision(valorFactura||t.precio, valorUF);
      const comision5pct=Math.round((valorFactura||t.precio)*0.05);
      const tope10UF=Math.round(valorUF*10);
      ov.estado="CONFIRMADA"; ov.monto_facturado=valorFactura||t.precio; ov.valor_servicio_final=valorFactura||t.precio;
      ov.comision_final=comisionFinal; ov.comision_porcentaje=5; ov.comision_tope_uf=10;
      ov.tope_aplicado=comision5pct>tope10UF; ov.uf_del_dia=valorUF; ov.id_factura_transportista=archivoId;
      ov.fecha_confirmacion=new Date().toISOString(); ov.historial=ov.historial||[];
      ov.historial.push({ estado:"CONFIRMADA", fecha:new Date().toISOString(), actor:"sistema", nota:"Factura recibida. Comisión calculada." });
      await env.OVS.put("ov:"+ovId, JSON.stringify(ov));
      await crearNotificacion(env,ov.id_transportista,"ov_confirmada",`OV ${ov.id_ov} confirmada. Comision: ${formatCLP(comisionFinal)}.`,{ ovId:ov.id_ov, comisionFinal });
      await enviarEmail(env,{ to:ov.transportistaEmail, subject:`Comision confirmada - ${ov.id_ov} - TransMatch`, html:emailOVConfirmada(ov) });
      break;
    }
    return ok({ ok:true, archivoId });
  }

  if (path.match(/^\/api\/admin\/cliente\/[^/]+\/oc-config$/)&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const clienteId=path.split("/")[4];
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const emailKey=await env.USERS.get("id:"+clienteId); if(!emailKey) return err("Cliente no encontrado",404);
    const rawU=await env.USERS.get(emailKey); if(!rawU) return err("Cliente no encontrado",404);
    const u=JSON.parse(rawU); u.genera_oc_propia=!!body.genera_oc_propia; u.updatedAt=new Date().toISOString();
    await env.USERS.put(emailKey, JSON.stringify(u));
    return ok({ ok:true, genera_oc_propia:u.genera_oc_propia });
  }

  if (path === "/api/admin/ordenes-venta" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const ids=JSON.parse(await env.OVS.get("ovs:all")||"[]"); const ordenes=[];
    for(const id of ids.slice(0,200)){ const raw=await env.OVS.get("ov:"+id); if(raw){ let ov=JSON.parse(raw); ov=await verificarVencimiento(env,ov); ordenes.push(ov); } }
    return ok({ ordenes });
  }

  if (path.match(/^\/api\/admin\/ordenes-venta\/[^/]+\/anular$/) && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const ovId=path.split("/")[4]; const raw=await env.OVS.get("ov:"+ovId); if(!raw) return err("OV no encontrada",404);
    const ov=JSON.parse(raw);
    if(ov.estado!=="CONDICIONAL") return err("Solo se pueden anular OV en estado CONDICIONAL");
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.motivo_anulacion) return err("motivo_anulacion requerido");
    ov.estado="ANULADA"; ov.motivo_anulacion=body.motivo_anulacion; ov.observaciones=body.observaciones||null; ov.anulado_por_admin=body.anulado_por_admin||user.email; ov.fecha_anulacion=new Date().toISOString();
    ov.historial=ov.historial||[]; ov.historial.push({ estado:"ANULADA", fecha:new Date().toISOString(), actor:"admin:"+user.email, nota:"Anulada. Motivo: "+body.motivo_anulacion });
    await env.OVS.put("ov:"+ovId, JSON.stringify(ov));
    await crearNotificacion(env,ov.id_transportista,"ov_anulada",`OV ${ov.id_ov} anulada. Motivo: ${ov.motivo_anulacion}`,{ ovId });
    return ok({ ok:true });
  }

  if (path === "/api/mis-ordenes-venta" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    // La madre ve las OV de toda la empresa; el sub-usuario solo las suyas.
    let ovIds=[];
    if(user.esSubusuario){
      ovIds=JSON.parse(await env.OVS.get("ovs:transportista:"+user.id)||"[]");
    } else {
      const emails=await emailsEmpresa(env,user); const seen=new Set();
      for(const em of emails){ const r=await env.USERS.get(em); if(!r) continue; const mu=JSON.parse(r); const list=JSON.parse(await env.OVS.get("ovs:transportista:"+mu.id)||"[]"); for(const x of list){ if(!seen.has(x)){ seen.add(x); ovIds.push(x); } } }
    }
    const ordenes=[];
    for(const id of ovIds.slice(0,200)){ const raw=await env.OVS.get("ov:"+id); if(raw){ let ov=JSON.parse(raw); ov=await verificarVencimiento(env,ov); ordenes.push(ov); } }
    return ok({ ordenes });
  }

  if (path.match(/^\/api\/admin\/ordenes-venta\/[^\/]+\/pagar$/) && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const ovId=path.split("/")[4]; const raw=await env.OVS.get("ov:"+ovId); if(!raw) return err("OV no encontrada",404);
    const ov=JSON.parse(raw);
    if(!["CONFIRMADA","FACTURADA"].includes(ov.estado)) return err("Solo se pueden pagar OV confirmadas o facturadas");
    let body={}; try{body=await request.json();}catch(e){}
    ov.estado="PAGADA"; ov.fecha_pago_confirmado=new Date().toISOString(); ov.metodo_pago=body.metodo_pago||"transferencia";
    ov.historial=ov.historial||[]; ov.historial.push({ estado:"PAGADA", fecha:new Date().toISOString(), actor:"admin", nota:body.nota||"" });
    await env.OVS.put("ov:"+ovId, JSON.stringify(ov));
    await crearNotificacion(env,ov.id_transportista,"ov_pagada",`OV ${ov.id_ov} marcada como pagada.`,{ ovId });
    return ok({ ok:true });
  }

  if (path === "/api/admin/facturas-mensuales" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const ids=JSON.parse(await env.OVS.get("facturas:all")||"[]"); const facturas=[];
    for(const id of ids.slice(0,100)){ const raw=await env.OVS.get("factura:"+id); if(raw) facturas.push(JSON.parse(raw)); }
    return ok({ facturas });
  }

  if (path === "/api/admin/facturacion-batch" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { periodo } = body; if(!periodo) return err("periodo requerido (formato YYYY-MM)");
    const ovIds=JSON.parse(await env.OVS.get("ovs:all")||"[]"); const ovsDelPeriodo=[];
    for(const id of ovIds){ const raw=await env.OVS.get("ov:"+id); if(!raw) continue; const ov=JSON.parse(raw); if(ov.estado!=="CONFIRMADA") continue; if(!ov.fecha_confirmacion) continue; if(ov.fecha_confirmacion.substring(0,7)!==periodo) continue; ovsDelPeriodo.push(ov); }
    if(ovsDelPeriodo.length===0) return err("Sin OV confirmadas en este periodo");
    const porTransportista={};
    for(const ov of ovsDelPeriodo){ const tid=ov.id_transportista; if(!porTransportista[tid]) porTransportista[tid]={ transportistaId:tid, transportistaEmail:ov.transportistaEmail, transportistaEmpresa:ov.transportistaEmpresa, ovs:[] }; porTransportista[tid].ovs.push(ov); }
    const facturaIds=[];
    for(const [tid, grupo] of Object.entries(porTransportista)){
      const facturaId=uid(); const totalComision=grupo.ovs.reduce((s,o)=>s+(o.comision_final||0),0);
      const factura={ id:facturaId, periodo, transportistaId:tid, transportistaEmail:grupo.transportistaEmail, transportistaEmpresa:grupo.transportistaEmpresa, total_ovs:grupo.ovs.length, total_comision:totalComision, ovs_ids:grupo.ovs.map(o=>o.id_ov), estado_pago:"pendiente", fecha_emision:new Date().toISOString(), fecha_pago:null, metodo_pago:null, notas:null };
      await env.OVS.put("factura:"+facturaId, JSON.stringify(factura));
      for(const ov of grupo.ovs){ ov.estado="FACTURADA"; ov.id_factura_transmatch=facturaId; ov.fecha_facturacion=new Date().toISOString(); ov.fecha_vencimiento=new Date(Date.now()+30*24*60*60*1000).toISOString(); ov.historial=ov.historial||[]; ov.historial.push({ estado:"FACTURADA", fecha:new Date().toISOString(), actor:"admin", nota:"Incluida en factura mensual "+periodo }); await env.OVS.put("ov:"+ov.id_ov, JSON.stringify(ov)); }
      const idxT=JSON.parse(await env.OVS.get("facturas:transportista:"+tid)||"[]"); idxT.unshift(facturaId); await env.OVS.put("facturas:transportista:"+tid, JSON.stringify(idxT));
      facturaIds.push(facturaId);
      await crearNotificacion(env,tid,"factura_mensual",`Factura mensual ${periodo}: ${formatCLP(totalComision)} por ${grupo.ovs.length} transporte(s)`,{ facturaId });
      await enviarEmail(env,{ to:grupo.transportistaEmail, subject:`Factura mensual ${periodo} - TransMatch`, html:emailFacturaMensual(factura) });
    }
    const idxAll=JSON.parse(await env.OVS.get("facturas:all")||"[]"); idxAll.unshift(...facturaIds); await env.OVS.put("facturas:all", JSON.stringify(idxAll));
    return ok({ ok:true, facturas_generadas:facturaIds.length, transportistas:Object.keys(porTransportista).length });
  }

  if (path.match(/^\/api\/admin\/facturas-mensuales\/[^/]+\/pago$/) && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const facturaId=path.split("/")[4]; const raw=await env.OVS.get("factura:"+facturaId); if(!raw) return err("Factura no encontrada",404);
    const factura=JSON.parse(raw); let body={}; try{body=await request.json();}catch(e){}
    factura.estado_pago="pagado"; factura.fecha_pago=new Date().toISOString(); factura.metodo_pago=body.metodo_pago||"transferencia"; factura.notas=body.notas||null;
    await env.OVS.put("factura:"+facturaId, JSON.stringify(factura));
    for(const ovId of (factura.ovs_ids||[])){ const rawOV=await env.OVS.get("ov:"+ovId); if(!rawOV) continue; const ov=JSON.parse(rawOV); ov.estado="PAGADA"; ov.fecha_pago_confirmado=new Date().toISOString(); ov.metodo_pago=factura.metodo_pago; ov.historial=ov.historial||[]; ov.historial.push({ estado:"PAGADA", fecha:new Date().toISOString(), actor:"admin", nota:"Pago confirmado en factura mensual "+factura.periodo }); await env.OVS.put("ov:"+ovId, JSON.stringify(ov)); }
    await crearNotificacion(env,factura.transportistaId,"pago_confirmado",`Pago confirmado: ${formatCLP(factura.total_comision)} - Periodo ${factura.periodo}`,{ facturaId });
    return ok({ ok:true });
  }

  if (path === "/api/mis-facturas-transmatch" && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const ids=JSON.parse(await env.OVS.get("facturas:transportista:"+user.id)||"[]"); const facturas=[];
    for(const id of ids.slice(0,50)){ const raw=await env.OVS.get("factura:"+id); if(raw) facturas.push(JSON.parse(raw)); }
    return ok({ facturas });
  }

  if (path === "/api/transportista/historial" && method === "GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const emailsT = await emailsEmpresa(env, user);
    const ids=JSON.parse(await env.LICITACIONES.get("all")||"[]"); const resultado=[];
    for(const id of ids.slice(0,200)){ const raw=await env.LICITACIONES.get(id); if(!raw) continue; const l=JSON.parse(raw); const miCotiz=(l.cotizaciones||[]).find(c=>c.transportistaEmail&&emailsT.has(c.transportistaEmail.toLowerCase())); const laGane=l.adjudicadaA&&l.adjudicadaA.transportistaEmail&&emailsT.has(l.adjudicadaA.transportistaEmail.toLowerCase()); if(!miCotiz&&!laGane) continue;
      // Si cotizamos y NO ganamos (y ya se adjudicó), calculamos nuestra posición vs. el resto —
      // esto es lo que se le muestra al transportista como feedback de por qué no lo adjudicaron.
      let posPrecio=null, posEntrega=null, posValoracion=null, totalCotizaciones=null;
      if(miCotiz && !laGane && (l.estado==="adjudicada"||l.estado==="completada")){
        const todasCotiz=l.cotizaciones||[];
        totalCotizaciones=todasCotiz.length;
        const porPrecio=[...todasCotiz].sort((a,b)=>(a.precio||0)-(b.precio||0));
        const fEntrega=function(c){ var f=(c.formulario&&c.formulario.fechaEntrega)||c.fechaEntregaISO||c.tiempoEntrega; var t=f?new Date(f).getTime():NaN; return isNaN(t)?Infinity:t; };
        const porEntrega=[...todasCotiz].sort((a,b)=>fEntrega(a)-fEntrega(b));
        const porValoracion=[...todasCotiz].sort((a,b)=>(b.transportistaRating||0)-(a.transportistaRating||0));
        posPrecio=porPrecio.findIndex(x=>x.id===miCotiz.id)+1;
        posEntrega=porEntrega.findIndex(x=>x.id===miCotiz.id)+1;
        posValoracion=porValoracion.findIndex(x=>x.id===miCotiz.id)+1;
      }
      // Para el transportista, una licitación anulada por el cliente se muestra como "cerrada".
      const estadoVista = (l.estado==="anulada") ? "cerrada" : l.estado;
      resultado.push({ id:l.id, codigo:l.codigo, tipoEquipo:l.tipoEquipo, marca:l.marca, origen:l.origen, destino:l.destino, estado:estadoVista, createdAt:l.createdAt, adjudicadaAt:l.adjudicadaAt, miCotizacion:miCotiz?{ id:miCotiz.id, precio:miCotiz.precio, tiempoEntrega:miCotiz.tiempoEntrega, score:miCotiz.score, createdAt:miCotiz.createdAt, creadoPor:(!user.esSubusuario ? (miCotiz.transportistaNombre||'') : '') }:null, gane:laGane, precioAdjudicado:laGane?l.adjudicadaA.precio:null, valoracion:laGane?(l.valoracion||null):null, posPrecio, posEntrega, posValoracion, totalCotizaciones }); }
    return ok({ licitaciones:resultado });
  }

  if (path.match(/^\/api\/retornos\/[^/]+$/) && method === "PUT") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get(id); if(!raw) return err("No encontrado",404);
    const r=JSON.parse(raw); if(!(await puedeGestionarRetorno(env,user,r))) return err("Sin acceso",403);
    if(r.estado!=="disponible") return err("Solo puedes editar retornos disponibles",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const campos=["ciudadOrigen","ciudadDestino","fechaDesde","fechaHasta","equipo","capacidad","precio","descripcion","descripción"];
    for(const k of campos){ if(body[k]!==undefined) r[k]=body[k]; }
    if(body.precio) r.precio=parseFloat(body.precio);
    r.updatedAt=new Date().toISOString();
    await env.RETORNOS.put(id,JSON.stringify(r));
    return ok({ ok:true });
  }

  if (path.match(/^\/api\/retornos\/[^/]+\/desactivar$/) && method === "POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get(id); if(!raw) return err("No encontrado",404);
    const r=JSON.parse(raw); if(!(await puedeGestionarRetorno(env,user,r))) return err("Sin acceso",403);
    r.estado="inactivo"; r.desactivadoAt=new Date().toISOString();
    await env.RETORNOS.put(id, JSON.stringify(r));
    return ok({ ok:true });
  }

  if (path === "/api/cotizaciones/editar" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { licitacionId, precio, tiempoEntrega, fechaCargaISO, fechaEntregaISO, descripcion, archivoId, archivoNombre, archivoPdfId, archivoPdfNombre, formulario } = body;
    if(!licitacionId||!precio) return err("licitacionId y precio requeridos");
    const raw=await env.LICITACIONES.get(licitacionId); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.estado!=="abierta") return err("Solo puedes editar cotizaciones de licitaciones abiertas");
    const idx=(l.cotizaciones||[]).findIndex(c=>c.transportistaId===user.id);
    if(idx===-1) return err("No tienes una cotización en esta licitación");
    l.cotizaciones[idx].precio=parseFloat(precio); l.cotizaciones[idx].tiempoEntrega=tiempoEntrega||l.cotizaciones[idx].tiempoEntrega;
    if(fechaCargaISO!==undefined) l.cotizaciones[idx].fechaCargaISO=fechaCargaISO;
    if(fechaEntregaISO!==undefined) l.cotizaciones[idx].fechaEntregaISO=fechaEntregaISO;
    if(descripcion!==undefined) l.cotizaciones[idx].descripcion=descripcion;
    if(archivoId){ l.cotizaciones[idx].archivoId=archivoId; l.cotizaciones[idx].archivoNombre=archivoNombre; }
    if(archivoPdfId){ l.cotizaciones[idx].archivoPropioId=archivoPdfId; l.cotizaciones[idx].archivoPropioNombre=archivoPdfNombre; }
    if(formulario!==undefined) l.cotizaciones[idx].formulario=formulario;
    l.cotizaciones[idx].editadoAt=new Date().toISOString();
    const todosPrecios=l.cotizaciones.map(c=>c.precio);
    l.cotizaciones=l.cotizaciones.map(c=>({...c,_allPrecios:todosPrecios,score:calcScore({...c,_allPrecios:todosPrecios},l.fechaCarga)})).sort((a,b)=>b.score-a.score);
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    return ok({ ok:true, mensaje:"Cotización actualizada" });
  }

  // GET cotización propia del transportista (para editar en el formulario)
  if (path.match(/^\/api\/cotizaciones\/mia\/[^\/]+$/) && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const licitacionId=path.split("/")[4];
    const raw=await env.LICITACIONES.get(licitacionId); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    const emails=await emailsEmpresa(env,user);
    const mc=(l.cotizaciones||[]).find(c=>c.transportistaId===user.id || (c.transportistaEmail&&emails.has(c.transportistaEmail.toLowerCase())));
    if(!mc) return err("No tienes una cotización en esta licitación",404);
    const out=Object.assign({}, mc);
    if(user.esSubusuario) out.transportistaNombre=''; // solo la madre ve quién la hizo
    return ok({ cotizacion:out });
  }

  if (path === "/api/cotizaciones/eliminar" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { licitacionId } = body; if(!licitacionId) return err("licitacionId requerido");
    const raw=await env.LICITACIONES.get(licitacionId); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.estado!=="abierta") return err("Solo puedes eliminar cotizaciones de licitaciones abiertas");
    l.cotizaciones=(l.cotizaciones||[]).filter(c=>c.transportistaId!==user.id);
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    return ok({ ok:true, mensaje:"Cotización eliminada" });
  }

  if (path.match(/^\/api\/transportes\/[^\/]+\/subir-guia$/) && method === "POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="cliente") return err("Solo el cliente puede subir la guía de despacho",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw);
    if((t.empresaId||t.clienteId)!==(user.esSubusuario?(user.empresaMadreId||user.id):user.id)) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.base64) return err("Archivo requerido");
    const archivoId=uid();
    await env.ARCHIVOS.put(archivoId, JSON.stringify({ base64:body.base64, mimeType:body.mimeType, nombre:body.nombre, createdAt:new Date().toISOString() }));
    t.guiaDespacho={ archivoId, nombre:body.nombre||"guia_despacho.pdf", subidoAt:new Date().toISOString(), subidoPor:"cliente" };
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    if(t.transportistaId) await crearNotificacion(env, t.transportistaId, "guia_disponible", "El cliente ha subido la guía de despacho.", { transporteId:id });
    const ovIds=JSON.parse(await env.OVS.get("ovs:all")||"[]");
    for(const ovId of ovIds){ const rawOV=await env.OVS.get("ov:"+ovId); if(!rawOV) continue; const ov=JSON.parse(rawOV); if(ov.id_transporte!==id) continue; ov.id_guia_despacho=archivoId; ov.historial=ov.historial||[]; ov.historial.push({ estado:ov.estado, fecha:new Date().toISOString(), actor:user.nombre||user.email, nota:"Guía de despacho subida." }); await env.OVS.put("ov:"+ovId, JSON.stringify(ov)); break; }
    return ok({ ok:true, archivoId });
  }

  if (path.match(/^\/api\/admin\/ordenes-venta\/[^\/]+$/) && method === "GET") {
    const user=await getUser(request,env); const d=deny(user,"admin","transportista"); if(d) return d;
    const ovId=path.split("/")[4]; const raw=await env.OVS.get("ov:"+ovId); if(!raw) return err("OV no encontrada",404);
    let ov=JSON.parse(raw); ov=await verificarVencimiento(env,ov);
    if(user.role==="transportista"&&ov.id_transportista!==user.id) return err("Sin acceso",403);
    return ok({ ov });
  }

  // ── EQUIPOS PENDIENTES DE APROBACIÓN ─────────────────────────
  // GET /api/admin/equipos-pendientes
  if (path === "/api/admin/equipos-pendientes" && method === "GET") {
    const user = await getUser(request, env); const d = deny(user,"admin"); if(d) return d;
    const pendientes = JSON.parse(await env.SESSIONS.get("equipos:pendientes")||"[]");
    return ok({ pendientes });
  }

  // POST /api/admin/equipos-pendientes/:id/resolver
  if (path.match(/^\/api\/admin\/equipos-pendientes\/[^/]+\/resolver$/) && method === "POST") {
    const user = await getUser(request, env); const d = deny(user,"admin"); if(d) return d;
    const id = path.split("/")[4];
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { accion, nombreAprobado } = body; // accion: aprobar | rechazar
    if(!["aprobar","rechazar"].includes(accion)) return err("accion debe ser aprobar o rechazar");
    const pendientes = JSON.parse(await env.SESSIONS.get("equipos:pendientes")||"[]");
    const idx = pendientes.findIndex(p => p.id === id);
    if(idx === -1) return err("No encontrado", 404);
    const equipo = pendientes[idx];
    pendientes[idx].estado = accion === "aprobar" ? "aprobado" : "rechazado";
    pendientes[idx].nombreAprobado = nombreAprobado || equipo.texto;
    pendientes[idx].resolvedAt = new Date().toISOString();
    await env.SESSIONS.put("equipos:pendientes", JSON.stringify(pendientes));
    // Notificar al transportista
    if(equipo.email) {
      const rawT = await env.USERS.get(equipo.email);
      if(rawT) {
        const uT = JSON.parse(rawT);
        const msg = accion==="aprobar"
          ? `Tu equipo "${equipo.texto}" fue aprobado como "${pendientes[idx].nombreAprobado}" y ya está disponible.`
          : `Tu equipo "${equipo.texto}" no pudo ser aprobado. Contacta a soporte para más información.`;
        await crearNotificacion(env, uT.id, "equipo_"+accion, msg, { equipoId: id });
        // Si fue aprobado, actualizar tiposEquipo del transportista
        if(accion === "aprobar") {
          if(!uT.tiposEquipo) uT.tiposEquipo = [];
          uT.tiposEquipo.push(pendientes[idx].nombreAprobado);
          await env.USERS.put(equipo.email, JSON.stringify(uT));
        }
      }
    }
    return ok({ ok:true, accion, nombreAprobado: pendientes[idx].nombreAprobado });
  }

  // ── MULTI-USUARIO ─────────────────────────────────────────────

  // GET /api/mi-empresa/usuarios — lista usuarios de la misma empresa
  if (path === "/api/mi-empresa/usuarios" && method === "GET") {
    const user = await getUser(request, env);
    if(!user) return err("No autenticado", 401);
    if(!["cliente","transportista"].includes(user.role)) return err("Sin permisos", 403);
    const rawAdmin = await env.USERS.get(user.email);
    if(!rawAdmin) return err("No encontrado", 404);
    const uAdmin = JSON.parse(rawAdmin);
    // Solo el admin de empresa puede ver el listado
    if(uAdmin.empresaAdminEmail && uAdmin.empresaAdminEmail !== user.email) return err("Solo el admin de empresa puede ver usuarios", 403);
    const miembrosIds = uAdmin.empresaMiembros || [];
    const miembros = [];
    for(const email of miembrosIds) {
      const raw = await env.USERS.get(email); if(!raw) continue;
      const m = JSON.parse(raw);
      miembros.push({ id:m.id, email:m.email, nombre:m.nombre, permisos:m.permisos||{}, estado:m.estado, createdAt:m.createdAt });
    }
    // Incluir invitaciones pendientes/vencidas
    const ahora = Date.now();
    const invitacionesPendientes = (uAdmin.invitacionesPendientes || []).map(inv => {
      const expira = new Date(inv.expiresAt).getTime();
      return { emailInvitado: inv.emailInvitado, createdAt: inv.createdAt, expiresAt: inv.expiresAt, vencida: ahora > expira };
    }).filter(inv => (ahora - new Date(inv.expiresAt).getTime()) < 7*24*3600000);
    uAdmin.invitacionesPendientes = (uAdmin.invitacionesPendientes || []).filter(inv =>
      (ahora - new Date(inv.expiresAt).getTime()) < 7*24*3600000
    );
    await env.USERS.put(user.email, JSON.stringify(uAdmin));
    return ok({ miembros, max_usuarios: uAdmin.max_usuarios||0, invitacionesPendientes });
  }

  // POST /api/mi-empresa/invitar — admin empresa invita a un usuario
  if (path === "/api/mi-empresa/invitar" && method === "POST") {
    const user = await getUser(request, env);
    if(!user) return err("No autenticado", 401);
    const rawAdmin = await env.USERS.get(user.email);
    if(!rawAdmin) return err("No encontrado", 404);
    const uAdmin = JSON.parse(rawAdmin);
    // Verificar que es admin de empresa
    if(uAdmin.empresaAdminEmail && uAdmin.empresaAdminEmail !== user.email) return err("Solo el admin puede invitar", 403);
    const maxU = uAdmin.max_usuarios || 0;
    const miembros = uAdmin.empresaMiembros || [];
    if(miembros.length >= maxU) return err(`Límite de ${maxU} usuarios extra alcanzado`, 403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { emailInvitado, permisos } = body;
    if(!emailInvitado) return err("emailInvitado requerido");
    // Verificar que no está ya registrado
    const existe = await env.USERS.get(emailInvitado.toLowerCase());
    if(existe) return err("Este email ya tiene una cuenta en TransMatch");
    // Crear token de invitación (expira en 48h)
    const token = uid();
    const invitacion = {
      token, emailInvitado: emailInvitado.toLowerCase(),
      empresaAdminEmail: user.email, empresa: uAdmin.empresa||"",
      role: uAdmin.role, permisos: permisos||{},
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 48*3600000).toISOString()
    };
    await env.SESSIONS.put("invitacion:"+token, JSON.stringify(invitacion), { expirationTtl: 172800 });
    // Guardar en lista de invitaciones pendientes del admin
    if (!uAdmin.invitacionesPendientes) uAdmin.invitacionesPendientes = [];
    uAdmin.invitacionesPendientes = uAdmin.invitacionesPendientes.filter(i => i.emailInvitado !== emailInvitado.toLowerCase());
    uAdmin.invitacionesPendientes.push({ token, emailInvitado: emailInvitado.toLowerCase(), createdAt: invitacion.createdAt, expiresAt: invitacion.expiresAt });
    await env.USERS.put(user.email, JSON.stringify(uAdmin));
    // Enviar email de invitación
    const linkInvitacion = `https://transmatch.cl/registro.html?invitacion=${token}`;
    const envio = await enviarEmail(env, {
      to: emailInvitado,
      subject: `${uAdmin.empresa||user.nombre} te invita a TransMatch`,
      html: emailBase(`
        <h2 style="font-size:24px;font-weight:800;color:#1e2d4e;margin:0 0 8px;letter-spacing:-0.4px">Tienes una invitación</h2>
        <p style="font-size:15px;color:#64748B;margin:0 0 8px;line-height:1.7">Hola, te han invitado a unirte a la plataforma.</p>
        <p style="font-size:15px;color:#64748B;margin:0 0 28px;line-height:1.7"><strong style="color:#1e2d4e">${uAdmin.empresa||user.nombre}</strong> te invita a ser usuario de su cuenta en TransMatch.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;margin:0 0 28px">
          <tr><td style="padding:20px 24px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:0.06em">Empresa que te invita</p>
            <p style="margin:0;font-size:16px;font-weight:700;color:#1e2d4e">${uAdmin.empresa||user.nombre}</p>
          </td></tr>
        </table>
        ${btnEmail(linkInvitacion, 'Aceptar invitación →', '#FF8904')}
        <p style="font-size:13px;color:#94A3B8;margin:20px 0 0;text-align:center;line-height:1.6">Este link expira en <strong style="color:#64748B">48 horas</strong>.<br>Si no esperabas esta invitación, puedes ignorar este email.</p>
      `, "Invitación a TransMatch")
    });
    return ok({ ok:true, emailEnviado: !!(envio && envio.ok), linkInvitacion, mensaje: (envio && envio.ok) ? "Invitación enviada a "+emailInvitado : "Invitación creada. No se pudo enviar el email automáticamente; comparte el link manualmente." });
  }

  // DELETE /api/mi-empresa/invitacion/:email — cancelar una invitación pendiente
  if (path.match(/^\/api\/mi-empresa\/invitacion\/[^/]+$/) && method === "DELETE") {
    const user = await getUser(request, env);
    if(!user) return err("No autenticado", 401);
    if(!["cliente","transportista"].includes(user.role)) return err("Sin permisos", 403);
    const rawAdmin = await env.USERS.get(user.email);
    if(!rawAdmin) return err("No encontrado", 404);
    const uAdmin = JSON.parse(rawAdmin);
    if(uAdmin.empresaAdminEmail && uAdmin.empresaAdminEmail !== user.email) return err("Solo el admin de empresa puede cancelar invitaciones", 403);
    const emailCancelar = decodeURIComponent(path.split("/").pop()).toLowerCase();
    const lista = uAdmin.invitacionesPendientes || [];
    const inv = lista.find(i => i.emailInvitado === emailCancelar);
    if(inv && inv.token) await env.SESSIONS.delete("invitacion:"+inv.token);
    uAdmin.invitacionesPendientes = lista.filter(i => i.emailInvitado !== emailCancelar);
    await env.USERS.put(user.email, JSON.stringify(uAdmin));
    return ok({ ok:true });
  }

  // GET /api/invitacion/:token — verificar token de invitación
  if (path.match(/^\/api\/invitacion\/[^/]+$/) && method === "GET") {
    const token = path.split("/")[3];
    const raw = await env.SESSIONS.get("invitacion:"+token);
    if(!raw) return err("Invitación no encontrada o expirada", 404);
    const inv = JSON.parse(raw);
    if(new Date(inv.expiresAt) < new Date()) return err("Invitación expirada", 410);
    return ok({ invitacion: { emailInvitado:inv.emailInvitado, empresa:inv.empresa, role:inv.role } });
  }

  // POST /api/invitacion/:token/aceptar — crear cuenta desde invitación
  if (path.match(/^\/api\/invitacion\/[^/]+\/aceptar$/) && method === "POST") {
    const token = path.split("/")[3];
    const raw = await env.SESSIONS.get("invitacion:"+token);
    if(!raw) return err("Invitación no encontrada o expirada", 404);
    const inv = JSON.parse(raw);
    if(new Date(inv.expiresAt) < new Date()) return err("Invitación expirada", 410);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { nombre, password, cargo, telefono, rut } = body;
    if(!nombre||!password) return err("nombre y password requeridos");
    if(!cargo||!telefono||!rut) return err("cargo, telefono y rut requeridos");
    if(password.length < 8) return err("Contraseña mínimo 8 caracteres");
    // Verificar que no existe aún
    const existe = await env.USERS.get(inv.emailInvitado);
    if(existe) return err("Este email ya tiene una cuenta");
    // Leer la cuenta madre PRIMERO (necesario para empresaMadreId y para vincular el miembro)
    const rawAdmin = await env.USERS.get(inv.empresaAdminEmail);
    if(!rawAdmin) return err("La cuenta de empresa que te invitó ya no existe", 404);
    const uAdmin = JSON.parse(rawAdmin);
    // Crear usuario
    const nuevoUser = {
      id: uid(), email: inv.emailInvitado, password: await hashPassword(password),
      nombre, empresa: inv.empresa, role: inv.role,
      cargo: cargo||"", telefono: telefono||"", rut: rut||"",
      estado: "activo", plan: null,
      rating: 5.0, totalTransportes: 0, zonas: [], equipos: [], tiposEquipo: [],
      empresaAdminEmail: inv.empresaAdminEmail, // vincula a la empresa
      permisos: inv.permisos || {},
      esSubusuario: true,
      empresaMadreId: uAdmin.id,
      createdAt: new Date().toISOString(),
    };
    await env.USERS.put(inv.emailInvitado, JSON.stringify(nuevoUser));
    await env.USERS.put("id:"+nuevoUser.id, inv.emailInvitado);
    // Agregar a la lista de miembros del admin (sin duplicar)
    if(!uAdmin.empresaMiembros) uAdmin.empresaMiembros = [];
    if(!uAdmin.empresaMiembros.includes(inv.emailInvitado)) uAdmin.empresaMiembros.push(inv.emailInvitado);
    // Quitar la invitación de la lista de pendientes ya que fue aceptada
    if(Array.isArray(uAdmin.invitacionesPendientes)) uAdmin.invitacionesPendientes = uAdmin.invitacionesPendientes.filter(i => i.emailInvitado !== inv.emailInvitado);
    await env.USERS.put(inv.empresaAdminEmail, JSON.stringify(uAdmin));
    // Invalidar token
    await env.SESSIONS.delete("invitacion:"+token);
    const jwtToken = await signToken({ id:nuevoUser.id, email:inv.emailInvitado, role:inv.role, nombre, empresa:inv.empresa, plan:null, esSubusuario:true, empresaMadreId:uAdmin.id }, env.JWT_SECRET);
    return ok({ token:jwtToken, user:{ id:nuevoUser.id, email:inv.emailInvitado, role:inv.role, nombre, empresa:inv.empresa, plan:null, permisos:nuevoUser.permisos, esSubusuario:true } });
  }

  // PUT /api/mi-empresa/usuario/:email/permisos — admin empresa edita permisos
  if (path.match(/^\/api\/mi-empresa\/usuario\/[^/]+\/permisos$/) && method === "PUT") {
    const user = await getUser(request, env);
    if(!user) return err("No autenticado", 401);
    const emailTarget = decodeURIComponent(path.split("/")[4]);
    const rawAdmin = await env.USERS.get(user.email);
    if(!rawAdmin) return err("No encontrado", 404);
    const uAdmin = JSON.parse(rawAdmin);
    if(uAdmin.empresaAdminEmail && uAdmin.empresaAdminEmail !== user.email) return err("Sin permisos", 403);
    const rawTarget = await env.USERS.get(emailTarget);
    if(!rawTarget) return err("Usuario no encontrado", 404);
    const uTarget = JSON.parse(rawTarget);
    if(uTarget.empresaAdminEmail !== user.email) return err("Este usuario no pertenece a tu empresa", 403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    uTarget.permisos = body.permisos || {};
    await env.USERS.put(emailTarget, JSON.stringify(uTarget));
    return ok({ ok:true });
  }

  // DELETE /api/mi-empresa/usuario/:email — admin empresa elimina miembro
  if (path.match(/^\/api\/mi-empresa\/usuario\/[^/]+$/) && method === "DELETE") {
    const user = await getUser(request, env);
    if(!user) return err("No autenticado", 401);
    const emailTarget = decodeURIComponent(path.split("/")[4]);
    const rawAdmin = await env.USERS.get(user.email);
    if(!rawAdmin) return err("No encontrado", 404);
    const uAdmin = JSON.parse(rawAdmin);
    if(uAdmin.empresaAdminEmail && uAdmin.empresaAdminEmail !== user.email) return err("Sin permisos", 403);
    // Eliminar de la lista de miembros
    uAdmin.empresaMiembros = (uAdmin.empresaMiembros||[]).filter(e => e !== emailTarget);
    await env.USERS.put(user.email, JSON.stringify(uAdmin));
    await env.USERS.delete(emailTarget);
    return ok({ ok:true });
  }

  // POST /api/admin/gestionar-usuario — agregar max_usuarios al endpoint existente
  // (ya existe, pero ahora también acepta max_usuarios)

  // ── FIN MULTI-USUARIO ──────────────────────────────────────────

  // POST /api/transportes/:id/equipo
  if (path.match(/^\/api\/transportes\/[^/]+\/equipo$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    if(user.role !== "transportista") return err("Solo transportistas",403);
    const id = path.split("/")[3];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw); if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.patente) return err("patente requerida");
    t.equipoAsignado = {
      patente: body.patente,
      tipo: body.tipo||"",
      marca: body.marca||"",
      modelo: body.modelo||"",
      equipoId: body.equipoId||null,
      documentos: body.documentos||null,
    };
    t.historial = t.historial||[];
    t.historial.push({ estado:t.estado, fecha:new Date().toISOString(), actor:user.nombre||user.email, nota:"Equipo asignado: "+body.patente });
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true });
  }

  // POST /api/transportes/:id/conductor
  if (path.match(/^\/api\/transportes\/[^/]+\/conductor$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    if(user.role !== "transportista") return err("Solo transportistas",403);
    const id = path.split("/")[3];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw); if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.nombre||!body.rut) return err("nombre y rut requeridos");
    t.conductorAsignado = {
      nombre: body.nombre,
      rut: body.rut,
      telefono: body.telefono||"",
      conductorId: body.conductorId||null,
      carnetFrenteId: body.carnetFrenteId||null, carnetFrenteNombre: body.carnetFrenteNombre||null,
      carnetReversoId: body.carnetReversoId||null, carnetReversoNombre: body.carnetReversoNombre||null,
      licenciaFrenteId: body.licenciaFrenteId||null, licenciaFrenteNombre: body.licenciaFrenteNombre||null,
      licenciaReversoId: body.licenciaReversoId||null, licenciaReversoNombre: body.licenciaReversoNombre||null,
    };
    t.historial = t.historial||[];
    t.historial.push({ estado:t.estado, fecha:new Date().toISOString(), actor:user.nombre||user.email, nota:"Conductor asignado: "+body.nombre });
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true });
  }

  // POST /api/transportes/:id/documento-extra — seguros, contratos, permisos, etc. (transportista)
  if (path.match(/^\/api\/transportes\/[^/]+\/documento-extra$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    if(user.role !== "transportista") return err("Solo transportistas",403);
    const id = path.split("/")[3];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw); if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.label||!String(body.label).trim()) return err("Indica un nombre para el documento (ej: Seguro de carga)");
    if(!body.base64) return err("Archivo requerido");
    const archivoId=uid();
    await env.ARCHIVOS.put(archivoId, JSON.stringify({ base64:body.base64, mimeType:body.mimeType, nombre:body.nombre, createdAt:new Date().toISOString() }));
    const doc={ id:uid(), label:String(body.label).trim().slice(0,80), archivoId, archivoNombre:body.nombre||"documento.pdf", subidoAt:new Date().toISOString(), subidoPor:user.nombre||user.email };
    t.documentosExtra = t.documentosExtra||[];
    t.documentosExtra.push(doc);
    t.historial = t.historial||[];
    t.historial.push({ estado:t.estado, fecha:new Date().toISOString(), actor:user.nombre||user.email, nota:"Documento agregado: "+doc.label });
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true, documento:doc });
  }

  // DELETE /api/transportes/:id/documento-extra/:docId
  if (path.match(/^\/api\/transportes\/[^/]+\/documento-extra\/[^/]+$/) && method === "DELETE") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    if(user.role !== "transportista") return err("Solo transportistas",403);
    const parts = path.split("/"); const id = parts[3]; const docId = parts[5];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw); if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    t.documentosExtra = (t.documentosExtra||[]).filter(function(d){ return d.id!==docId; });
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true });
  }

  // POST /api/transportes/:id/requisito/:reqId — subir archivo de un requisito del estandar
  if (path.match(/^\/api\/transportes\/[^/]+\/requisito\/[^/]+$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    if(user.role !== "transportista") return err("Solo transportistas",403);
    const parts = path.split("/"); const id = parts[3]; const reqId = parts[5];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw); if(!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.base64) return err("Archivo requerido");
    const reqs = t.requisitosEstandar||[]; const req = reqs.find(function(r){ return r.id===reqId; });
    if(!req) return err("Requisito no encontrado",404);
    const archivoId=uid();
    await env.ARCHIVOS.put(archivoId, JSON.stringify({ base64:body.base64, mimeType:body.mimeType, nombre:body.nombre, createdAt:new Date().toISOString() }));
    req.archivoId=archivoId; req.archivoNombre=body.nombre||"documento.pdf"; req.subidoAt=new Date().toISOString(); req.subidoPor=user.nombre||user.email;
    t.requisitosEstandar=reqs;
    t.historial = t.historial||[];
    t.historial.push({ estado:t.estado, fecha:new Date().toISOString(), actor:user.nombre||user.email, nota:"Documento de requisito cargado: "+(req.label||reqId) });
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true, requisito:req });
  }
  // POST /api/transportes/:id/contacto-operacional
  if (path.match(/^\/api\/transportes\/[^/]+\/contacto-operacional$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    const id = path.split("/")[3];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw);
    if(user.role==="cliente"&&t.clienteEmail!==user.email) return err("Sin acceso",403);
    if(user.role==="transportista"&&!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { rol, contacto } = body;
    if(!rol||!contacto||!contacto.nombre||!contacto.telefono) return err("rol, nombre y telefono requeridos");
    if(!["cliente","transportista"].includes(rol)) return err("rol debe ser cliente o transportista");
    if(!t.contactosOperacionales) t.contactosOperacionales={};
    if(!t.contactosOperacionales[rol]) t.contactosOperacionales[rol]=[];
    if(t.contactosOperacionales[rol].length>=2) return err("Máximo 2 contactos por rol");
    t.contactosOperacionales[rol].push(contacto);
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true });
  }

  // DELETE /api/transportes/:id/contacto-operacional/:rol/:idx
  if (path.match(/^\/api\/transportes\/[^/]+\/contacto-operacional\/[^/]+\/\d+$/) && method === "DELETE") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    const parts = path.split("/");
    const id = parts[3]; const rol = parts[5]; const idx = parseInt(parts[6]);
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw);
    if(user.role==="cliente"&&t.clienteEmail!==user.email) return err("Sin acceso",403);
    if(user.role==="transportista"&&!(await puedeGestionarTransporte(env,user,t))) return err("Sin acceso",403);
    if(t.contactosOperacionales&&t.contactosOperacionales[rol])
      t.contactosOperacionales[rol].splice(idx,1);
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true });
  }

  // ── DIRECCIONES ───────────────────────────────────────────────
  // POST /api/transportes/:id/direcciones
  if (path.match(/^\/api\/transportes\/[^/]+\/direcciones$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    if(user.role !== "cliente") return err("Solo clientes",403);
    const id = path.split("/")[3];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw); if((t.empresaId||t.clienteId)!==(user.esSubusuario?(user.empresaMadreId||user.id):user.id)) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.direcciones) return err("direcciones requerido");
    t.direcciones = body.direcciones;
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    // Notificar al transportista
    await crearNotificacion(env, t.transportistaEmail ? (await env.USERS.get(t.transportistaEmail) ? JSON.parse(await env.USERS.get(t.transportistaEmail)).id : "") : "", "direcciones_actualizadas", `El cliente actualizó las direcciones de carga y descarga del transporte ${t.codigo}.`, { transporteId: id });
    return ok({ ok:true });
  }

  return corsResponse(JSON.stringify({ error:"Ruta no encontrada" }), 404);
}

export default {
  fetch: handleRequest,
  async scheduled(event, env, ctx) {
    // Ejecutado por el Cron Trigger de Cloudflare (ej: cada 10 min)
    ctx.waitUntil(procesarLicitacionesVencidas(env));
    // Barrido de vencimientos de documentos (se auto-limita a 1 vez al día)
    ctx.waitUntil(procesarVencimientosDocumentos(env));
  }
};
