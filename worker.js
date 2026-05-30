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
  return await verifyToken(token, env.JWT_SECRET);
}

function deny(user, ...roles) {
  if (!user)                      return err("No autenticado", 401);
  if (!roles.includes(user.role)) return err("Sin permisos", 403);
  return null;
}

async function obtenerUF() {
  try {
    const res  = await fetch("https://mindicador.cl/api/uf");
    const data = await res.json();
    return data.serie[0].valor;
  } catch(e) { return 38500; }
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

function puedeTransportar(tiposEquipo, licitacion) {
  if (!tiposEquipo || tiposEquipo.length === 0) return false;
  if (!licitacion.tipoEquipoRequerido || licitacion.tipoEquipoRequerido === "cualquiera") return true;
  const requeridos = licitacion.tipoEquipoRequerido.split(" / ").map(s => s.toLowerCase().trim());
  return tiposEquipo.some(tipo => {
    const t = (tipo || "").toLowerCase().trim();
    return requeridos.some(req => t === req || t.includes(req) || req.includes(t));
  });
}

function anonimizarCliente(l) {
  return { ...l, clienteEmail:undefined, clienteNombre:undefined, clienteEmpresa: l.clienteEmpresa ? "Empresa verificada TransMatch" : "Empresa verificada" };
}

function anonimizarTransportista(c) {
  return {
    id:c.id, licitacionId:c.licitacionId, precio:c.precio, tiempoEntrega:c.tiempoEntrega,
    descripcion:c.descripcion, incluye:c.incluye, tiempoRespuesta:c.tiempoRespuesta,
    transportistaRating:c.transportistaRating, transportistaTransportes:c.transportistaTransportes,
    archivoId:c.archivoId, archivoNombre:c.archivoNombre, score:c.score, createdAt:c.createdAt,
    transportistaLabel:`Transportista Verificado ${c.transportistaRating||5}`,
  };
}

async function enviarEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method:"POST",
      headers:{ "Authorization":"Bearer "+env.RESEND_API_KEY, "Content-Type":"application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM||"TransMatch <noreply@transmatch.cl>", to:[to], subject, html }),
    });
  } catch(e) { console.error("Email error:", e.message); }
}

function emailBase(contenido, titulo) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${titulo}</title></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 16px">
    <tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
      <tr><td style="background:#1e2d4e;border-radius:12px 12px 0 0;padding:20px 28px;text-align:center">
        <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
          <td style="background:#FF8904;border-radius:8px;width:32px;height:32px;text-align:center;vertical-align:middle;font-weight:900;color:#fff;font-size:16px">T</td>
          <td style="padding-left:8px;font-weight:700;color:#fff;font-size:18px">TransMatch</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#fff;padding:28px;border-radius:0 0 12px 12px">
        ${contenido}
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid #F3F4F6;text-align:center;font-size:12px;color:#9CA3AF">
          Email automatico de TransMatch · <a href="https://transmatch.cl" style="color:#1e2d4e;text-decoration:none">transmatch.cl</a>
        </div>
      </td></tr>
    </table></td></tr>
  </table>
</body></html>`;
}

function btnEmail(href, texto, color='#1e2d4e') {
  return `<div style="text-align:center;margin:20px 0"><a href="${href}" style="background:${color};color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block">${texto}</a></div>`;
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

async function crearNotificacion(env, userId, tipo, mensaje, datos={}) {
  const id = uid();
  const notif = { id, userId, tipo, mensaje, datos, leida:false, createdAt:new Date().toISOString() };
  await env.SESSIONS.put(`notif:${userId}:${id}`, JSON.stringify(notif));
  const idx = JSON.parse(await env.SESSIONS.get(`notifs:${userId}`) || "[]");
  idx.unshift(id);
  await env.SESSIONS.put(`notifs:${userId}`, JSON.stringify(idx.slice(0,50)));
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
      notifEmail:false, notifWhatsapp:false, whatsapp:whatsapp||"",
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
    const token = await signToken({ id:user.id, email:emailLower, role:user.role, nombre:user.nombre, empresa:user.empresa, plan:user.plan }, env.JWT_SECRET);
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
    if (user.estado==="pendiente")  return err("Cuenta pendiente de aprobacion",403);
    if (user.estado==="suspendido") return err("Cuenta suspendida",403);
    if (user.estado==="rechazado")  return err("Registro rechazado. Contacta al administrador",403);
    const token = await signToken({ id:user.id, email:emailLower, role:user.role, nombre:user.nombre, empresa:user.empresa, plan:user.plan }, env.JWT_SECRET);
    return ok({ token, role:user.role, nombre:user.nombre, empresa:user.empresa, plan:user.plan });
  }

  if (path === "/api/auth/me" && method === "GET") {
    const user = await getUser(request, env);
    if (!user) return err("Token invalido",401);
    if (user.role==="admin") return ok({ user:{ id:"admin", email:user.email, role:"admin", nombre:"Administrador", empresa:"TransMatch", plan:null } });
    const raw = await env.USERS.get(user.email);
    if (!raw) return err("Usuario no encontrado",404);
    const u = JSON.parse(raw);
    return ok({ user:{ id:u.id, email:u.email, role:u.role, nombre:u.nombre, empresa:u.empresa, plan:u.plan, rating:u.rating, totalTransportes:u.totalTransportes, estado:u.estado, notifEmail:u.notifEmail, notifWhatsapp:u.notifWhatsapp, whatsapp:u.whatsapp, telefono:u.telefono, ciudad:u.ciudad, rut:u.rut, rutEmpresa:u.rutEmpresa, cargo:u.cargo, giro:u.giro, telEmpresa:u.telEmpresa, ciudadEmpresa:u.ciudadEmpresa, direccion:u.direccion, web:u.web, descripcion:u.descripcion, anosExperiencia:u.anosExperiencia, zonas:u.zonas||[], equipos:u.equipos||[], tiposEquipo:u.tiposEquipo||[], facturacion:u.facturacion||{}, contactoOperaciones:u.contactoOperaciones, contactoComercial:u.contactoComercial, contactoFacturacion:u.contactoFacturacion, industrias:u.industrias||[], max_usuarios:u.max_usuarios||0, esSubusuario:u.esSubusuario||false, permisos:u.permisos||{}, perfilCompletitud:u.perfilCompletitud||0, totalCotizaciones:u.totalCotizaciones||0 } });
  }

  if (path === "/api/licitaciones" && method === "POST") {
    const user = await getUser(request, env);
    const d = deny(user,"cliente","admin"); if(d) return d;
    let body = {}; try { body = await request.json(); } catch(e) { return err("Formato invalido"); }
    const { tipoEquipo, marca, peso, dimensiones, descripcion, origen, destino, fechaCarga, fechaEntrega, plazo, archivoId, archivoNombre, tipoLicitacion, tipoCarga, cantidadBultos, pesoPorBulto } = body;
    if (!origen||!destino||!fechaCarga) return err("Faltan campos requeridos");
    const id = uid(); const codigo = await generarCodigo(env,'LIC');
    const licitacion = { id, codigo, clienteId:user.id, clienteEmail:user.email, clienteEmpresa:user.empresa||"", clienteNombre:user.nombre||"", clienteTelefono:user.telefono||"", tipoLicitacion:tipoLicitacion||"maquinaria", tipoEquipo:tipoEquipo||tipoCarga||"Carga general", tipoEquipoRequerido:body.tipoEquipoRequerido||"cualquiera", marca:marca||"", tipoCarga:tipoCarga||"", cantidadBultos:cantidadBultos||"", pesoPorBulto:pesoPorBulto||"", peso:peso||"", dimensiones:dimensiones||"", descripcion:descripcion||"", origen, destino, fechaCarga, fechaEntrega:fechaEntrega||"", plazo:plazo||"24", archivoId:archivoId||null, archivoNombre:archivoNombre||null, estado:"pendiente_admin", cotizaciones:[], cotizacionesEnviadas:[], ronda:0, createdAt:new Date().toISOString(), cierreAt:new Date(Date.now()+parseInt(plazo||"24")*3600000).toISOString() };
    await env.LICITACIONES.put(id, JSON.stringify(licitacion));
    const idxC = JSON.parse(await env.LICITACIONES.get("cliente:"+user.id)||"[]"); idxC.unshift(id); await env.LICITACIONES.put("cliente:"+user.id, JSON.stringify(idxC));
    const idxA = JSON.parse(await env.LICITACIONES.get("all")||"[]"); idxA.unshift(id); await env.LICITACIONES.put("all", JSON.stringify(idxA));
    await crearNotificacion(env,"admin","nueva_licitacion",`Nueva licitacion: ${licitacion.tipoEquipo} - ${origen} - ${destino}`,{ licitacionId:id });
    return ok({ ok:true, id, mensaje:"Licitacion enviada." });
  }

  if (path === "/api/licitaciones" && method === "GET") {
    const user = await getUser(request, env);
    if (!user) return err("No autenticado",401);
    let ids = [];
    if (user.role==="admin") ids = JSON.parse(await env.LICITACIONES.get("all")||"[]");
    else if (user.role==="cliente") ids = JSON.parse(await env.LICITACIONES.get("cliente:"+user.id)||"[]");
    else if (user.role==="transportista") ids = JSON.parse(await env.LICITACIONES.get("all")||"[]");
    let equiposTransportista = [];
    if (user.role==="transportista") { const rawT = await env.USERS.get(user.email); if (rawT) equiposTransportista = JSON.parse(rawT).tiposEquipo||[]; }
    const licitaciones = [];
    for (const id of ids.slice(0,100)) {
      const raw = await env.LICITACIONES.get(id); if (!raw) continue;
      let l = JSON.parse(raw);
      if (!l.codigo) { l.codigo = await generarCodigo(env,'LIC'); await env.LICITACIONES.put(id, JSON.stringify(l)); }
      if (user.role==="transportista") {
        if (["abierta","cerrada"].includes(l.estado)) { if (!puedeTransportar(equiposTransportista,l)) continue; licitaciones.push(anonimizarCliente(l)); }
        else if (["adjudicada","completada"].includes(l.estado) && l.adjudicadaA?.transportistaEmail===user.email) licitaciones.push(l);
        else continue;
      } else if (user.role==="cliente") {
        const lCopy = { ...l };
        lCopy.cotizaciones = (l.cotizacionesEnviadas||[]).map((cot,idx) => { if(!cot.id) cot.id=(l.cotizaciones||[]).find(x=>x.precio===cot.precio&&x.tiempoEntrega===cot.tiempoEntrega)?.id||('cotiz_'+idx); return anonimizarTransportista(cot); });
        lCopy.totalCotizaciones = (l.cotizaciones||[]).length;
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
    if (user.role==="cliente"&&l.clienteId!==user.id) return err("Sin acceso",403);
    if (user.role==="transportista") { if(!["abierta","cerrada"].includes(l.estado)) return err("Sin acceso",403); return ok({ licitacion:anonimizarCliente(l) }); }
    if (user.role==="cliente") { const lCopy={...l}; lCopy.cotizaciones=(l.cotizacionesEnviadas||[]).map(anonimizarTransportista); lCopy.totalCotizaciones=(l.cotizaciones||[]).length; return ok({ licitacion:lCopy }); }
    return ok({ licitacion:l });
  }

  if (path.startsWith("/api/licitaciones/") && path.split("/").length===4 && method==="DELETE") {
    const id = path.split("/")[3]; const user = await getUser(request,env); if(!user) return err("No autenticado",401);
    const raw = await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l = JSON.parse(raw);
    if (user.role==="cliente"&&l.clienteId!==user.id) return err("Sin acceso",403);
    if (user.role==="cliente"&&l.estado!=="pendiente_admin") return err("Solo puedes eliminar licitaciones pendientes",403);
    await env.LICITACIONES.delete(id);
    const idxC = JSON.parse(await env.LICITACIONES.get("cliente:"+user.id)||"[]"); await env.LICITACIONES.put("cliente:"+user.id, JSON.stringify(idxC.filter(x=>x!==id)));
    const idxA = JSON.parse(await env.LICITACIONES.get("all")||"[]"); await env.LICITACIONES.put("all", JSON.stringify(idxA.filter(x=>x!==id)));
    return ok({ ok:true });
  }

  if (path === "/api/cotizaciones" && method === "POST") {
    const user = await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { licitacionId, precio, tiempoEntrega, fechaEntregaISO, descripcion, incluye, archivoId, archivoNombre } = body;
    if (!licitacionId||!precio) return err("licitacionId y precio son requeridos");
    if (!archivoId) return err("Debes adjuntar el archivo con tu propuesta");
    const raw = await env.LICITACIONES.get(licitacionId); if(!raw) return err("No encontrada",404);
    const l = JSON.parse(raw);
    if (l.estado!=="abierta") return err("Esta licitacion no esta abierta");
    if ((l.cotizaciones||[]).find(c=>c.transportistaId===user.id)) return err("Ya enviaste una cotizacion");
    const rawUser = await env.USERS.get(user.email); const userData = rawUser ? JSON.parse(rawUser) : {};
    const cotizacion = { id:uid(), codigo:await generarCodigo(env,'COT'), licitacionId, transportistaId:user.id, transportistaNombre:user.nombre, transportistaEmpresa:user.empresa, transportistaEmail:user.email, transportistaTelefono:userData.telefono||"", transportistaRating:userData.rating||5.0, transportistaTransportes:userData.totalTransportes||0, precio:parseFloat(precio), tiempoEntrega:tiempoEntrega||"", fechaEntregaISO:fechaEntregaISO||null, descripcion:descripcion||"", incluye:incluye||[], archivoId:archivoId||null, archivoNombre:archivoNombre||null, tiempoRespuesta:Math.floor((Date.now()-new Date(l.createdAt).getTime())/60000), score:0, createdAt:new Date().toISOString() };
    l.cotizaciones = [...(l.cotizaciones||[]), cotizacion];
    const todosPrecios = l.cotizaciones.map(c=>c.precio);
    l.cotizaciones = l.cotizaciones.map(c=>({...c,_allPrecios:todosPrecios,score:calcScore({...c,_allPrecios:todosPrecios},l.fechaCarga)})).sort((a,b)=>b.score-a.score);
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    await crearNotificacion(env,"admin","nueva_cotizacion",`Nueva cotizacion: ${l.tipoEquipo} - ${l.origen}-${l.destino} - ${formatCLP(parseFloat(precio))}`,{ licitacionId, cotizacionId:cotizacion.id });
    return ok({ ok:true, mensaje:"Cotizacion enviada." });
  }

  if (path.startsWith("/api/admin/licitacion/")&&path.endsWith("/aprobar")&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const id=path.split("/")[4]; const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.estado!=="pendiente_admin") return err("No esta pendiente");
    l.estado="abierta"; l.aprobadaAt=new Date().toISOString();
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,l.clienteId,"licitacion_aprobada",`Tu licitacion fue aprobada: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,{ licitacionId:id });
    await enviarEmail(env,{ to:l.clienteEmail, subject:"Tu licitacion fue aprobada - TransMatch", html:emailLicitacionAprobada(l) });
    return ok({ ok:true });
  }

  if (path.startsWith("/api/admin/licitacion/")&&path.endsWith("/rechazar")&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const id=path.split("/")[4]; let body={}; try{body=await request.json();}catch(e){}
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); l.estado="rechazada"; l.motivoRechazo=body.motivo||"";
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,l.clienteId,"licitacion_rechazada",`Tu licitacion fue rechazada: ${body.motivo||"Contacta al administrador"}`,{ licitacionId:id });
    return ok({ ok:true });
  }

  if (path.startsWith("/api/admin/licitacion/")&&path.endsWith("/cerrar")&&method==="POST") {
    const user=await getUser(request,env); const d=deny(user,"admin"); if(d) return d;
    const id=path.split("/")[4]; const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.estado!=="abierta") return err("No esta abierta");
    const cotizaciones=l.cotizaciones||[]; if(cotizaciones.length===0) return err("Sin cotizaciones");
    l.estado="cerrada"; l.cerradaAt=new Date().toISOString(); l.ronda=1;
    l.cotizacionesEnviadas=cotizaciones.slice(0,3).map(cot=>{ if(!cot.id) cot.id=uid(); return cot; });
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,l.clienteId,"cotizaciones_disponibles",`Tienes ${Math.min(3,cotizaciones.length)} cotizaciones: ${l.tipoEquipo} - ${l.origen} - ${l.destino}`,{ licitacionId:id });
    await enviarEmail(env,{ to:l.clienteEmail, subject:`Tienes cotizaciones listas - TransMatch`, html:emailCotizacionesListas(l,Math.min(3,cotizaciones.length)) });
    return ok({ ok:true, enviadas:Math.min(3,cotizaciones.length) });
  }

  if (path.startsWith("/api/licitaciones/") && path.split("/").length===4 && method==="PUT") {
    const id=path.split("/")[3]; const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw);
    if(user.role==="cliente"&&l.clienteId!==user.id) return err("Sin acceso",403);
    if(l.estado!=="pendiente_admin") return err("Solo puedes editar licitaciones pendientes de aprobacion");
    const campos=["tipoEquipo","tipoEquipoRequerido","marca","peso","dimensiones","descripcion","origen","destino","fechaCarga","fechaEntrega","plazo","tipoCarga","cantidadBultos","pesoPorBulto"];
    for(const k of campos){ if(body[k]!==undefined) l[k]=body[k]; }
    if(body.archivoId) { l.archivoId=body.archivoId; l.archivoNombre=body.archivoNombre; }
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
    if(user.role==="cliente"&&l.clienteId!==user.id) return err("Sin acceso",403);
    if(!["abierta","cerrada"].includes(l.estado)) return err("Solo puedes anular licitaciones abiertas o en revision de cotizaciones");
    l.estado="anulada"; l.anuladaAt=new Date().toISOString(); l.motivoAnulacion=body.motivo; l.anuladaPor=user.role;
    await env.LICITACIONES.put(id, JSON.stringify(l));
    await crearNotificacion(env,"admin","licitacion_anulada",`Licitacion anulada por cliente: ${l.tipoEquipo} - ${l.origen} - ${l.destino}. Motivo: ${body.motivo}`,{ licitacionId:id });
    return ok({ ok:true });
  }

  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/mas-cotizaciones")&&method==="POST") {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    if (!["pro","enterprise"].includes(user.plan)) return err("Requiere plan Pro o Enterprise",403);
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.clienteId!==user.id) return err("Sin acceso",403);
    if(l.estado!=="cerrada") return err("No esta en revision");
    const yaIds=new Set((l.cotizacionesEnviadas||[]).map(c=>c.id));
    const extras=(l.cotizaciones||[]).filter(c=>!yaIds.has(c.id)).slice(0,3);
    if(extras.length===0) return err("Sin mas cotizaciones");
    l.cotizacionesEnviadas=[...(l.cotizacionesEnviadas||[]),...extras]; l.ronda=(l.ronda||1)+1;
    await env.LICITACIONES.put(id, JSON.stringify(l));
    return ok({ ok:true, nuevas:extras.length });
  }

  if (path.startsWith("/api/licitaciones/")&&path.endsWith("/adjudicar")&&method==="POST") {
    const id=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"cliente","admin"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { cotizacionId } = body; if(!cotizacionId) return err("cotizacionId requerido");
    const raw=await env.LICITACIONES.get(id); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(user.role==="cliente"&&l.clienteId!==user.id) return err("Sin acceso",403);
    if(!["cerrada","abierta"].includes(l.estado)) return err("No se puede adjudicar");
    let cotiz=(l.cotizaciones||[]).find(c=>c.id===cotizacionId);
    if(!cotiz) { const enviadas=l.cotizacionesEnviadas||[]; const idxMatch=cotizacionId.match(/^cotiz_(\d+)$/); if(idxMatch){cotiz=enviadas[parseInt(idxMatch[1])];if(cotiz?.id)cotiz=(l.cotizaciones||[]).find(c=>c.id===cotiz.id)||cotiz;}else{cotiz=enviadas.find(c=>c.id===cotizacionId);} }
    if(!cotiz) return err("Cotizacion no encontrada");
    l.estado="adjudicada"; l.adjudicadaAt=new Date().toISOString();
    l.adjudicadaA={ cotizacionId, precio:cotiz.precio, transportistaId:cotiz.transportistaId, transportistaNombre:cotiz.transportistaNombre, transportistaEmpresa:cotiz.transportistaEmpresa, transportistaEmail:cotiz.transportistaEmail, transportistaTelefono:cotiz.transportistaTelefono, tiempoEntrega:cotiz.tiempoEntrega };
    await env.LICITACIONES.put(id, JSON.stringify(l));
    const codigoTRN=await generarCodigo(env,"TRN"); const transporteId=uid();
    const transporte={ id:transporteId, codigo:codigoTRN, licitacionId:id, licitacionCodigo:l.codigo||"", tipoEquipo:l.tipoEquipo+(l.marca?" - "+l.marca:""), origen:l.origen, destino:l.destino, precio:cotiz.precio, clienteEmail:l.clienteEmail, clienteEmpresa:l.clienteEmpresa, clienteNombre:l.clienteNombre||"", clienteTelefono:l.clienteTelefono||"", transportistaEmail:cotiz.transportistaEmail, transportistaNombre:cotiz.transportistaNombre, transportistaEmpresa:cotiz.transportistaEmpresa, transportistaTelefono:cotiz.transportistaTelefono||"", estado:"preparacion", estadoDocumentos:"pendiente", historial:[{ estado:"preparacion", nota:"Transporte creado al adjudicar", fecha:new Date().toISOString(), actor:"Sistema" }], oc:null, factura:null, adjudicadoAt:new Date().toISOString() };
    await env.RETORNOS.put("transporte:"+transporteId, JSON.stringify(transporte));
    const allT=JSON.parse(await env.RETORNOS.get("transportes:all")||"[]"); allT.unshift(transporteId); await env.RETORNOS.put("transportes:all", JSON.stringify(allT));
    const ov = await crearOV(env, { transporteId, licitacion:l, cotizacion:cotiz });
    await crearNotificacion(env,cotiz.transportistaId,"adjudicacion",`Ganaste: ${l.tipoEquipo} - ${l.origen} - ${l.destino} - ${formatCLP(cotiz.precio)}`,{ licitacionId:id, clienteEmpresa:l.clienteEmpresa, clienteEmail:l.clienteEmail, ovId:ov.id_ov });
    await enviarEmail(env,{ to:cotiz.transportistaEmail, subject:`Ganaste! ${l.tipoEquipo} - TransMatch`, html:emailAdjudicacionGanada(l,cotiz) });
    await crearNotificacion(env,cotiz.transportistaId,"ov_condicional",`OV ${ov.id_ov} creada. Comision estimada: ${formatCLP(ov.comision_estimada)}.`,{ ovId:ov.id_ov });
    const todasCotiz=l.cotizaciones||[];
    const porPrecio=[...todasCotiz].sort((a,b)=>a.precio-b.precio);
    for (const c of todasCotiz) {
      if(c.transportistaId===cotiz.transportistaId) continue;
      const pos=porPrecio.findIndex(x=>x.id===c.id)+1;
      await crearNotificacion(env,c.transportistaId,"licitacion_cerrada",`La licitacion fue adjudicada a otro. Estabas en posicion ${pos} de ${todasCotiz.length} por precio.`,{ licitacionId:id });
    }
    return ok({ ok:true, transportista:l.adjudicadaA, ovId:ov.id_ov });
  }

  if (path === "/api/valoraciones" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"cliente"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { licitacionId, scores, promedio, comentario } = body; if(!licitacionId) return err("licitacionId requerido");
    const raw=await env.LICITACIONES.get(licitacionId); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.clienteEmail!==user.email) return err("Sin acceso",403);
    if(l.estado!=="adjudicada") return err("Solo puedes valorar licitaciones adjudicadas");
    if(l.valoracion) return err("Ya valoraste");
    const prom=promedio||(scores?Math.round((Object.values(scores).reduce((a,b)=>a+b,0)/Object.values(scores).length)*10)/10:5);
    l.valoracion={ scores:scores||{}, promedio:prom, comentario:comentario||"", createdAt:new Date().toISOString() }; l.estado="completada";
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    if(l.adjudicadaA?.transportistaEmail) {
      const rawT=await env.USERS.get(l.adjudicadaA.transportistaEmail);
      if(rawT){ const t=JSON.parse(rawT); const prev=t.totalTransportes||0; t.totalTransportes=prev+1; t.rating=Math.round(((((t.rating||5)*prev)+prom)/t.totalTransportes)*10)/10; await env.USERS.put(l.adjudicadaA.transportistaEmail, JSON.stringify(t)); }
    }
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
    return ok({ ok:true, id, mensaje:"Retorno publicado." });
  }

  if (path === "/api/retornos" && method === "GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role==="cliente"&&!["pro","enterprise"].includes(user.plan)) return err("Requiere plan Pro o Enterprise",403);
    const ids=JSON.parse(await env.RETORNOS.get("all")||"[]");
    const retornos=[];
    for (const id of ids.slice(0,50)) {
      const raw=await env.RETORNOS.get(id); if(!raw) continue;
      const r=JSON.parse(raw); if(r.estado!=="disponible") continue;
      if(user.role==="cliente") delete r.transportistaEmail;
      retornos.push(r);
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
    const email=url.searchParams.get("email")||user.email;
    if(email!==user.email&&user.role!=="admin") return err("Sin acceso",403);
    const raw=await env.USERS.get(email); if(!raw) return err("No encontrado",404);
    return ok({ equipos:JSON.parse(raw).equipos||[] });
  }

  if (path === "/api/equipos" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    if(!body.tipo) return err("tipo requerido");
    const raw=await env.USERS.get(user.email); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw); if(!u.equipos) u.equipos=[];
    const equipo={ id:uid(), tipo:body.tipo, marca:body.marca||"", modelo:body.modelo||"", ano:body.ano||"", capacidadMax:parseFloat(body.capacidadMax)||0, largoMax:parseFloat(body.largoMax)||0, anchoMax:parseFloat(body.anchoMax)||0, altoMax:parseFloat(body.altoMax)||0, patente:body.patente||"", descripcion:body.descripcion||"", documentos:{}, createdAt:new Date().toISOString() };
    u.equipos.push(equipo);
    await env.USERS.put(user.email, JSON.stringify(u));
    return ok({ ok:true, id:equipo.id });
  }

  if (path.startsWith("/api/equipos/")&&path.split("/").length===4&&method==="DELETE") {
    const equipoId=path.split("/")[3]; const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    const raw=await env.USERS.get(user.email); if(!raw) return err("No encontrado",404);
    const u=JSON.parse(raw); u.equipos=(u.equipos||[]).filter(e=>e.id!==equipoId);
    await env.USERS.put(user.email, JSON.stringify(u));
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
    if(body.id){ const raw=await env.SESSIONS.get(`notif:${userId}:${body.id}`); if(raw){ const n=JSON.parse(raw); n.leida=true; await env.SESSIONS.put(`notif:${userId}:${body.id}`, JSON.stringify(n)); } }
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

    return ok({ total:ids.length, pendiente_admin, abiertas, cerradas, adjudicadas, completadas, ovCondicionales, ovConfirmadas, ovFacturadas, comisionPendiente, comisionFacturada });
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
    if(accion==="aprobar"){ await crearNotificacion(env,u.id,"cuenta_aprobada","Tu cuenta fue aprobada! Ya puedes ver licitaciones y cotizar.",{}); await enviarEmail(env,{ to:u.email, subject:"Tu cuenta TransMatch fue aprobada", html:emailCuentaAprobada(u.nombre) }); }
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
          <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 24px">Si tienes alguna consulta urgente, puedes escribirnos directamente a <a href="mailto:hola@transmatch.cl" style="color:#ff8904">hola@transmatch.cl</a>.</p>
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
          from: "TransMatch <hola@transmatch.cl>",
          to: ["hola@transmatch.cl"],
          subject: "Nueva solicitud de contacto — " + nombre + " / " + empresa,
          html: htmlEquipo
        })
      });
      // Confirmación al solicitante
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "TransMatch <hola@transmatch.cl>",
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
    for(const key of lista.keys){ if(key.name.startsWith("id:")) continue; const raw=await env.USERS.get(key.name); if(!raw) continue; const u=JSON.parse(raw); usuarios.push({ id:u.id,email:u.email,nombre:u.nombre,empresa:u.empresa,role:u.role,estado:u.estado,plan:u.plan,createdAt:u.createdAt,rating:u.rating,totalTransportes:u.totalTransportes,telefono:u.telefono||'',rutEmpresa:u.rutEmpresa||'',cargo:u.cargo||'',max_usuarios:u.max_usuarios||0,empresaMiembros:u.empresaMiembros||[],notasAdmin:u.notasAdmin||'',equipos:u.equipos||[],tiposEquipo:u.tiposEquipo||[],zonas:u.zonas||[],rutRepresentante:u.rutRepresentante||'' }); }
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
    for(const k of ["nombre","empresa","telefono","rut","direccion","whatsapp","ciudad","giro","web","descripcion","anosExperiencia","zonas","equipos","tiposEquipo","genera_oc_propia","rutEmpresa","cargo","industrias","telEmpresa","ciudadEmpresa","facturacion","contactoOperaciones","contactoComercial","contactoFacturacion"]){ if(body[k]!==undefined) u[k]=body[k]; }
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
      if(u.contactoOperaciones)pts+=4;if(u.contactoComercial)pts+=4;if(u.contactoFacturacion)pts+=3;
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
    const allIds=JSON.parse(await env.RETORNOS.get("transportes:all")||"[]"); const transportes=[];
    for(const id of allIds){ const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) continue; const t=JSON.parse(raw); if(user.role==="admin"){ transportes.push(t); continue; } if(user.role==="cliente"&&t.clienteEmail===user.email) transportes.push(t); if(user.role==="transportista"&&t.transportistaEmail===user.email) transportes.push(t); }
    return ok({ transportes });
  }

  if (path.match(/^\/api\/transportes\/[^/]+$/)&&method==="GET") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    const id=path.split("/").pop(); const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if(user.role!=="admin"&&t.clienteEmail!==user.email&&t.transportistaEmail!==user.email) return err("Sin acceso",403);
    return ok({ transporte:t });
  }

  if (path.match(/^\/api\/transportes\/[^/]+\/estado$/)&&method==="POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if(t.transportistaEmail!==user.email) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){}
    const { estado, nota } = body;
    if(!["preparacion","en_ruta","carga_recogida","en_destino","entregado"].includes(estado)) return err("Estado invalido");
    t.estado=estado; t.historial=t.historial||[]; t.historial.push({ estado, nota:nota||"", fecha:new Date().toISOString(), actor:user.nombre||user.email });
    if(estado==="entregado") t.entregadoAt=new Date().toISOString();
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    return ok({ ok:true, estado });
  }

  if (path.match(/^\/api\/transportes\/[^/]+\/subir-oc$/)&&method==="POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="cliente") return err("Solo clientes",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if(t.clienteEmail!==user.email) return err("Sin acceso",403);
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
    const t=JSON.parse(raw); if(t.transportistaEmail!==user.email) return err("Sin acceso",403);
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

  if (path.match(/^\/api\/transportes\/[^/]+\/generar-oc$/)&&method==="POST") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="cliente") return err("Solo clientes",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if(t.clienteEmail!==user.email) return err("Sin acceso",403);
    if(t.oc) return err("Ya existe una OC para este transporte");
    const rawU=await env.USERS.get(user.email); const u=rawU?JSON.parse(rawU):{};
    const ocData={ tipo:"oc_automatica", numero:"OC-"+t.codigo, fecha:new Date().toISOString(), cliente:{ nombre:u.nombre||"", empresa:u.empresa||"", rut:u.rut||"", email:user.email }, transportista:{ nombre:t.transportistaNombre, empresa:t.transportistaEmpresa, email:t.transportistaEmail, telefono:t.transportistaTelefono||"" }, transporte:{ codigo:t.codigo, origen:t.origen, destino:t.destino, tipoEquipo:t.tipoEquipo, precio:t.precio }, generadoAt:new Date().toISOString() };
    const archivoId=uid();
    await env.ARCHIVOS.put(archivoId, JSON.stringify({ base64:btoa(JSON.stringify(ocData)), mimeType:"application/json", nombre:"OC-"+t.codigo+".json", tipo:"oc_automatica", createdAt:new Date().toISOString() }));
    t.oc={ archivoId, nombre:"OC-"+t.codigo+".json", subidoAt:new Date().toISOString(), subidoPor:"sistema", tipo:"oc_automatica" };
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
    await crearNotificacion(env, t.transportistaId||"", "oc_disponible", "El documento de adjudicacion esta disponible.", { transporteId:id });
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
    const ids=JSON.parse(await env.OVS.get("ovs:transportista:"+user.id)||"[]"); const ordenes=[];
    for(const id of ids.slice(0,100)){ const raw=await env.OVS.get("ov:"+id); if(raw){ let ov=JSON.parse(raw); ov=await verificarVencimiento(env,ov); ordenes.push(ov); } }
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
    const ids=JSON.parse(await env.LICITACIONES.get("all")||"[]"); const resultado=[];
    for(const id of ids.slice(0,200)){ const raw=await env.LICITACIONES.get(id); if(!raw) continue; const l=JSON.parse(raw); const miCotiz=(l.cotizaciones||[]).find(c=>c.transportistaEmail===user.email); const laGane=l.adjudicadaA&&l.adjudicadaA.transportistaEmail===user.email; if(!miCotiz&&!laGane) continue; resultado.push({ id:l.id, codigo:l.codigo, tipoEquipo:l.tipoEquipo, marca:l.marca, origen:l.origen, destino:l.destino, estado:l.estado, createdAt:l.createdAt, adjudicadaAt:l.adjudicadaAt, miCotizacion:miCotiz?{ id:miCotiz.id, precio:miCotiz.precio, tiempoEntrega:miCotiz.tiempoEntrega, score:miCotiz.score, createdAt:miCotiz.createdAt }:null, gane:laGane, precioAdjudicado:laGane?l.adjudicadaA.precio:null, valoracion:laGane?(l.valoracion||null):null }); }
    return ok({ licitaciones:resultado });
  }

  if (path.match(/^\/api\/retornos\/[^/]+$/) && method === "PUT") {
    const user=await getUser(request,env); if(!user) return err("No autenticado",401);
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get(id); if(!raw) return err("No encontrado",404);
    const r=JSON.parse(raw); if(r.transportistaId!==user.id) return err("Sin acceso",403);
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
    const r=JSON.parse(raw); if(user.role!=="admin"&&r.transportistaId!==user.id) return err("Sin acceso",403);
    r.estado="inactivo"; r.desactivadoAt=new Date().toISOString();
    await env.RETORNOS.put(id, JSON.stringify(r));
    return ok({ ok:true });
  }

  if (path === "/api/cotizaciones/editar" && method === "POST") {
    const user=await getUser(request,env); const d=deny(user,"transportista"); if(d) return d;
    let body={}; try{body=await request.json();}catch(e){return err("Formato invalido");}
    const { licitacionId, precio, tiempoEntrega, descripcion, archivoId, archivoNombre } = body;
    if(!licitacionId||!precio) return err("licitacionId y precio requeridos");
    const raw=await env.LICITACIONES.get(licitacionId); if(!raw) return err("No encontrada",404);
    const l=JSON.parse(raw); if(l.estado!=="abierta") return err("Solo puedes editar cotizaciones de licitaciones abiertas");
    const idx=(l.cotizaciones||[]).findIndex(c=>c.transportistaId===user.id);
    if(idx===-1) return err("No tienes una cotización en esta licitación");
    l.cotizaciones[idx].precio=parseFloat(precio); l.cotizaciones[idx].tiempoEntrega=tiempoEntrega||l.cotizaciones[idx].tiempoEntrega;
    if(descripcion!==undefined) l.cotizaciones[idx].descripcion=descripcion;
    if(archivoId){ l.cotizaciones[idx].archivoId=archivoId; l.cotizaciones[idx].archivoNombre=archivoNombre; }
    l.cotizaciones[idx].editadoAt=new Date().toISOString();
    const todosPrecios=l.cotizaciones.map(c=>c.precio);
    l.cotizaciones=l.cotizaciones.map(c=>({...c,_allPrecios:todosPrecios,score:calcScore({...c,_allPrecios:todosPrecios},l.fechaCarga)})).sort((a,b)=>b.score-a.score);
    await env.LICITACIONES.put(licitacionId, JSON.stringify(l));
    return ok({ ok:true, mensaje:"Cotización actualizada" });
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
    if(user.role!=="transportista") return err("Solo transportistas",403);
    const id=path.split("/")[3]; const raw=await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t=JSON.parse(raw); if(t.transportistaEmail!==user.email) return err("Sin acceso",403);
    let body={}; try{body=await request.json();}catch(e){}
    if(!body.base64) return err("Archivo requerido");
    const archivoId=uid();
    await env.ARCHIVOS.put(archivoId, JSON.stringify({ base64:body.base64, mimeType:body.mimeType, nombre:body.nombre, createdAt:new Date().toISOString() }));
    t.guiaDespacho={ archivoId, nombre:body.nombre||"guia_despacho.pdf", subidoAt:new Date().toISOString() };
    await env.RETORNOS.put("transporte:"+id, JSON.stringify(t));
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
    return ok({ miembros, max_usuarios: uAdmin.max_usuarios||0 });
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
    // Enviar email de invitación
    const linkInvitacion = `https://transmatch.cl/registro.html?invitacion=${token}`;
    await enviarEmail(env, {
      to: emailInvitado,
      subject: `${uAdmin.empresa||user.nombre} te invita a TransMatch`,
      html: emailBase(`
        <h2 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px">Fuiste invitado a TransMatch</h2>
        <p style="font-size:14px;color:#6B7280;margin:0 0 20px"><strong>${uAdmin.empresa||user.nombre}</strong> te invita a unirte como usuario de su cuenta.</p>
        <p style="font-size:13px;color:#374151;margin:0 0 20px">Haz click en el botón para crear tu contraseña y comenzar. El link expira en 48 horas.</p>
        ${btnEmail(linkInvitacion, 'Aceptar invitación', '#FF8904')}
        <p style="font-size:12px;color:#9CA3AF;margin-top:16px">Si no esperabas esta invitación, puedes ignorar este email.</p>
      `, "Invitación a TransMatch")
    });
    return ok({ ok:true, mensaje:"Invitación enviada a "+emailInvitado });
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
    const { nombre, password } = body;
    if(!nombre||!password) return err("nombre y password requeridos");
    if(password.length < 8) return err("Contraseña mínimo 8 caracteres");
    // Verificar que no existe aún
    const existe = await env.USERS.get(inv.emailInvitado);
    if(existe) return err("Este email ya tiene una cuenta");
    // Crear usuario
    const nuevoUser = {
      id: uid(), email: inv.emailInvitado, password: await hashPassword(password),
      nombre, empresa: inv.empresa, role: inv.role,
      estado: "activo", plan: null,
      rating: 5.0, totalTransportes: 0, zonas: [], equipos: [], tiposEquipo: [],
      empresaAdminEmail: inv.empresaAdminEmail, // vincula a la empresa
      permisos: inv.permisos || {},
      esSubusuario: true,
      createdAt: new Date().toISOString(),
    };
    await env.USERS.put(inv.emailInvitado, JSON.stringify(nuevoUser));
    await env.USERS.put("id:"+nuevoUser.id, inv.emailInvitado);
    // Agregar a la lista de miembros del admin
    const rawAdmin = await env.USERS.get(inv.empresaAdminEmail);
    if(rawAdmin) {
      const uAdmin = JSON.parse(rawAdmin);
      if(!uAdmin.empresaMiembros) uAdmin.empresaMiembros = [];
      uAdmin.empresaMiembros.push(inv.emailInvitado);
      await env.USERS.put(inv.empresaAdminEmail, JSON.stringify(uAdmin));
    }
    // Invalidar token
    await env.SESSIONS.delete("invitacion:"+token);
    const jwtToken = await signToken({ id:nuevoUser.id, email:inv.emailInvitado, role:inv.role, nombre, empresa:inv.empresa, plan:null }, env.JWT_SECRET);
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

  return corsResponse(JSON.stringify({ error:"Ruta no encontrada" }), 404);
  // POST /api/transportes/:id/equipo
  if (path.match(/^\/api\/transportes\/[^/]+\/equipo$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    if(user.role !== "transportista") return err("Solo transportistas",403);
    const id = path.split("/")[3];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw); if(t.transportistaEmail !== user.email) return err("Sin acceso",403);
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

  // ── CONTACTO OPERACIONAL ──────────────────────────────────────
  // POST /api/transportes/:id/contacto-operacional
  if (path.match(/^\/api\/transportes\/[^/]+\/contacto-operacional$/) && method === "POST") {
    const user = await getUser(request, env); if(!user) return err("No autenticado",401);
    const id = path.split("/")[3];
    const raw = await env.RETORNOS.get("transporte:"+id); if(!raw) return err("No encontrado",404);
    const t = JSON.parse(raw);
    if(user.role==="cliente"&&t.clienteEmail!==user.email) return err("Sin acceso",403);
    if(user.role==="transportista"&&t.transportistaEmail!==user.email) return err("Sin acceso",403);
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
    if(user.role==="transportista"&&t.transportistaEmail!==user.email) return err("Sin acceso",403);
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
    const t = JSON.parse(raw); if(t.clienteEmail!==user.email) return err("Sin acceso",403);
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

export default { fetch: handleRequest };
