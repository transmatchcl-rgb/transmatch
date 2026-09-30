/* ══════════════════════════════════════════════════════════════════
   TransMatch · MODO DEMO (portal cliente)
   Se activa SOLO si se entró por /demo.html (tm_demo=1 y tm_token=demo_token).
   Intercepta las llamadas a /api/ y responde con datos ficticios en memoria.
   No toca el worker, KV ni Supabase. Un login real lo desactiva solo.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  try{
    if(localStorage.getItem('tm_demo')!=='1' || localStorage.getItem('tm_token')!=='demo_token') return;
  }catch(e){ return; }

  var KEY='tm_demo_state_v1';
  var H=3600000, D=24*H, NOW=Date.now();
  function iso(ms){ return new Date(NOW+ms).toISOString(); }
  function fecha(ms){ return iso(ms).slice(0,10); }
  function fmtFecha(ms){ return new Date(NOW+ms).toLocaleDateString('es-CL'); }

  var CLI={ id:'demo_cliente', email:'demo@transmatch.cl', empresa:'Constructora Cordillera (Demo)', nombre:'Usuario Demo' };
  var TR={
    a:{ nombre:'Rodrigo Fuentes', empresa:'Transportes Altiplano (Demo)', email:'altiplano@demo.cl', tel:'+56 9 5555 0101', rating:4.8, total:37 },
    b:{ nombre:'Carolina Muñoz', empresa:'Logística Valle Sur (Demo)',   email:'vallesur@demo.cl',  tel:'+56 9 5555 0202', rating:4.6, total:22 },
    c:{ nombre:'Jorge Pizarro',  empresa:'Cargas Pesadas Norte (Demo)',  email:'cpnorte@demo.cl',   tel:'+56 9 5555 0303', rating:4.9, total:58 }
  };

  // ── Constructores ────────────────────────────────────────────
  function lic(o){
    return Object.assign({
      clienteId:CLI.id, empresaId:CLI.id, clienteEmpresa:CLI.empresa, clienteNombre:CLI.nombre,
      creadoPorEmail:CLI.email, creadoPorNombre:CLI.nombre, esCreadoPorSubusuario:false,
      tipoLicitacion:'maquinaria', tipoEquipoRequerido:'cualquiera', marca:'', modelo:'', cantidadEquipos:'1',
      pesoUnidad:'ton', volumen:'', paradas:[], tipoEntregaDestino:'no_aplica', plazo:'24', valorSeguro:'',
      contactoOrigenNombre:'Pedro Soto', contactoOrigenTelefono:'+56 9 5555 1111', contactoOrigenEmail:'bodega@demo.cl',
      contactoDestinoNombre:'Andrea Rojas', contactoDestinoTelefono:'+56 9 5555 2222', contactoDestinoEmail:'obra@demo.cl',
      horaCarga:'08:00', horaDescarga:'17:00', requiereEstandar:false, estandarRequisitos:[],
      archivoId:null, archivoNombre:null, esPrueba:false, cotizaciones:[], preguntas:[], ronda:0, totalCotizaciones:0
    }, o);
  }
  function cot(id, licId, t, precio, score, fCarga, fEntrega, equipo, ruta, incluye, desc, minResp){
    var iva=Math.round(precio*0.19);
    return {
      id:id, licitacionId:licId, precio:precio, modalidad:'No consolidada', tiempoEntrega:fEntrega,
      descripcion:desc, incluye:incluye, tiempoRespuesta:minResp,
      transportistaRating:t.rating, transportistaTransportes:t.total, archivoId:null, archivoNombre:null,
      score:score, createdAt:iso(-minResp*60000), transportistaLabel:'Transportista Verificado '+t.rating,
      _t:t,
      formulario:{
        equipoUtilizado:equipo, ruta:ruta, fechaCarga:fCarga, fechaEntrega:fEntrega, validez:'15 días',
        items:[
          { eq:equipo, cant:'1', tarifa:String(Math.round(precio*0.85)), unidad:'viaje', total:String(Math.round(precio*0.85)) },
          { eq:'Permiso MOP y escolta', cant:'1', tarifa:String(Math.round(precio*0.15)), unidad:'servicio', total:String(Math.round(precio*0.15)) }
        ],
        montoNeto:precio, iva:iva, montoTotal:precio+iva,
        seguros:[{ tipo:'Seguro de carga', cobertura:'3000', obs:'Cobertura todo riesgo durante el traslado' },{ tipo:'Responsabilidad civil', cobertura:'1000' }],
        esperaIncluida:'4 horas', cobroEspera:'35.000 + IVA por hora', cobroEstadia:'250.000 + IVA por día',
        observaciones:'Tarifa sujeta a condiciones de acceso informadas. Incluye amarre y aseguramiento de carga.'
      }
    };
  }
  var CONTACTO_CLI=[{ nombre:'Andrea Rojas', cargo:'Jefa de bodega', telefono:'+56 9 5555 2222', email:'obra@demo.cl' }];
  function trn(o){
    return Object.assign({
      empresaId:CLI.id, clienteEmail:CLI.email, clienteEmpresa:CLI.empresa, clienteNombre:CLI.nombre,
      creadoPorEmail:CLI.email, creadoPorNombre:CLI.nombre, estadoDocumentos:'pendiente',
      oc:null, factura:null, guiaDespacho:null, pod:null, documentosExtra:[], requisitosEstandar:[],
      incidenciasCliente:[], contactosOperacionales:{ cliente:CONTACTO_CLI, transportista:[] }
    }, o);
  }
  function conT(t){
    return { transportistaNombre:t.nombre, transportistaEmpresa:t.empresa, transportistaEmail:t.email, transportistaTelefono:t.tel,
      contactoEncargado:{ nombre:t.nombre, telefono:t.tel, email:t.email },
      contactosOperacionales:{ cliente:CONTACTO_CLI, transportista:[{ nombre:t.nombre, cargo:'Coordinador de operaciones', telefono:t.tel, email:t.email }] } };
  }
  function adj(t, cotId, precio, fEntrega){ return { cotizacionId:cotId, precio:precio, transportistaId:'demo_'+t.email, transportistaNombre:t.nombre, transportistaEmpresa:t.empresa, transportistaEmail:t.email, transportistaTelefono:t.tel, tiempoEntrega:fEntrega }; }
  function doc(nombre, ms){ return { archivoId:'demo_doc', nombre:nombre, subidoAt:iso(ms) }; }
  function hist(pasos){ return pasos.map(function(p){ return { estado:p[0], nota:p[1], fecha:iso(p[2]), actor:p[3]||'Sistema' }; }); }

  // ── Datos iniciales ──────────────────────────────────────────
  function seed(){
    var L=[], T=[];

    // 1) En revisión (pendiente_admin)
    L.push(lic({ id:'demo_l1', codigo:'LIC-D001', estado:'pendiente_admin', tipoEquipo:'Grúa horquilla', marca:'Toyota', modelo:'8FG50', peso:'7', dimensiones:'4,2 x 1,9 x 2,6 m',
      descripcion:'Grúa horquilla operativa, se carga con rampa.', origen:'Santiago', destino:'Rancagua', direccionOrigen:'Av. Américo Vespucio 1500, Pudahuel', direccionDestino:'Camino Longitudinal Sur km 88, Rancagua',
      fechaCarga:fecha(4*D), fechaEntrega:fecha(4*D), createdAt:iso(-2*H), cierreAt:iso(22*H) }));

    // 2) Abierta, cotizaciones llegando + pregunta sin responder
    L.push(lic({ id:'demo_l2', codigo:'LIC-D002', estado:'abierta', tipoEquipo:'Excavadora', marca:'Caterpillar', modelo:'320 GC', peso:'22', dimensiones:'9,5 x 3,0 x 3,1 m',
      descripcion:'Excavadora sobre orugas. Requiere cama baja y permiso de sobredimensión.', origen:'Santiago', destino:'Los Andes', direccionOrigen:'Camino a Noviciado 2300, Pudahuel', direccionDestino:'Ruta 60 CH km 12, Los Andes', ubicacionOrigen:'https://maps.app.goo.gl/demoPudahuel', ubicacionDestino:'5FQ2+7M Los Andes',
      fechaCarga:fecha(3*D), fechaEntrega:fecha(3*D), createdAt:iso(-6*H), aprobadaAt:iso(-5*H), cierreAt:iso(18*H), totalCotizaciones:2,
      preguntas:[{ id:'demo_p1', texto:'¿El punto de carga tiene acceso para cama baja de 3 ejes? ¿Hay restricción de horario?', respuesta:null, createdAt:iso(-3*H), respondidaAt:null, esTuya:false }] }));

    // 3) Abierta con estándar de faena + pregunta respondida
    L.push(lic({ id:'demo_l3', codigo:'LIC-D003', estado:'abierta', tipoLicitacion:'carga', tipoEquipo:'Generador eléctrico', tipoCarga:'Carga general', peso:'6,5', dimensiones:'4,8 x 1,6 x 2,2 m',
      descripcion:'Generador 500 kVA en skid, con puntos de izaje.', origen:'Antofagasta', destino:'Calama', direccionOrigen:'Av. Pedro Aguirre Cerda 9500, Antofagasta', direccionDestino:'Faena Demo, km 1350 Ruta 25',
      fechaCarga:fecha(5*D), fechaEntrega:fecha(5*D), createdAt:iso(-20*H), aprobadaAt:iso(-19*H), cierreAt:iso(28*H), plazo:'48', totalCotizaciones:1,
      requiereEstandar:true, estandarDetalle:'Ingreso a faena minera', estandarRequisitos:[{id:'r1',label:'Certificado de revisión técnica'},{id:'r2',label:'Seguro de carga vigente'},{id:'r3',label:'Licencia A5 del conductor'}],
      preguntas:[{ id:'demo_p2', texto:'¿Se requiere curso de inducción para ingresar a faena?', respuesta:'Sí, la inducción se hace el mismo día en portería (1 hora aprox.).', createdAt:iso(-15*H), respondidaAt:iso(-14*H), esTuya:false }] }));

    // 4) Cerrada → comparador (3 enviadas de 5)
    var r4='Santiago → Copiapó';
    var c4=[
      cot('demo_c41','demo_l4',TR.c,2850000,0.87,fmtFecha(2*D),fmtFecha(4*D),'Cama baja 3 ejes',r4,['Seguro de carga','Permiso MOP','Escolta'],'Incluye escolta y permisos de sobredimensión.',95),
      cot('demo_c42','demo_l4',TR.a,2690000,0.81,fmtFecha(2*D),fmtFecha(5*D),'Cama baja 3 ejes',r4,['Seguro de carga','Permiso MOP'],'Escolta se cobra aparte si Vialidad la exige.',180),
      cot('demo_c43','demo_l4',TR.b,3100000,0.63,fmtFecha(2*D),fmtFecha(4*D),'Cama baja extensible',r4,['Seguro de carga','Permiso MOP','Escolta','Grúa de apoyo'],'Incluye grúa de apoyo en descarga.',240)
    ];
    L.push(lic({ id:'demo_l4', codigo:'LIC-D004', estado:'cerrada', tipoEquipo:'Bulldozer', marca:'Caterpillar', modelo:'D6T', peso:'23', dimensiones:'5,6 x 3,3 x 3,2 m',
      descripcion:'Bulldozer con ripper. Sobredimensionado en ancho.', origen:'Santiago', destino:'Copiapó', direccionOrigen:'Av. Lo Espejo 01565, San Bernardo', direccionDestino:'Parque Industrial Paipote, Copiapó',
      fechaCarga:fecha(2*D), fechaEntrega:fecha(4*D), createdAt:iso(-2*D), aprobadaAt:iso(-2*D+H), cierreAt:iso(-2*H), cotizaciones:c4, totalCotizaciones:5 }));

    // 5) Cerrada → segundo comparador
    var r5='Concepción → Los Ángeles';
    var c5=[
      cot('demo_c51','demo_l5',TR.a,890000,0.84,fmtFecha(3*D),fmtFecha(3*D),'Rampla plana',r5,['Seguro de carga'],'Carga y descarga con rampa propia.',60),
      cot('demo_c52','demo_l5',TR.b,960000,0.72,fmtFecha(3*D),fmtFecha(3*D),'Cama baja 2 ejes',r5,['Seguro de carga','Amarre certificado'],'',130),
      cot('demo_c53','demo_l5',TR.c,1050000,0.66,fmtFecha(3*D),fmtFecha(4*D),'Cama baja 3 ejes',r5,['Seguro de carga','Permiso MOP'],'',210)
    ];
    L.push(lic({ id:'demo_l5', codigo:'LIC-D005', estado:'cerrada', tipoEquipo:'Retroexcavadora', marca:'JCB', modelo:'3CX', peso:'8,5', dimensiones:'5,9 x 2,4 x 3,6 m',
      descripcion:'Retroexcavadora 4x4.', origen:'Concepción', destino:'Los Ángeles', direccionOrigen:'Av. Colón 7000, Talcahuano', direccionDestino:'Obra Demo, Av. Alemania 850, Los Ángeles',
      fechaCarga:fecha(3*D), fechaEntrega:fecha(3*D), createdAt:iso(-1*D), aprobadaAt:iso(-1*D+H), cierreAt:iso(-1*H), cotizaciones:c5, totalCotizaciones:3 }));

    // 6) Adjudicada → transporte EN RUTA
    var c6=cot('demo_c61','demo_l6',TR.c,3450000,0.88,fmtFecha(-1*D),fmtFecha(1*D),'Cama baja 4 ejes','Santiago → Antofagasta',['Seguro de carga','Permiso MOP','Escolta'],'',70);
    L.push(lic({ id:'demo_l6', codigo:'LIC-D006', estado:'adjudicada', tipoEquipo:'Cargador frontal', marca:'Komatsu', modelo:'WA380', peso:'18', dimensiones:'8,1 x 2,9 x 3,4 m',
      origen:'Santiago', destino:'Antofagasta', fechaCarga:fecha(-1*D), fechaEntrega:fecha(1*D), createdAt:iso(-6*D), aprobadaAt:iso(-6*D+H), cierreAt:iso(-5*D), adjudicadaAt:iso(-4*D),
      cotizaciones:[c6], totalCotizaciones:4, adjudicadaA:adj(TR.c,'demo_c61',3450000,fmtFecha(1*D)) }));
    T.push(trn(Object.assign({ id:'demo_t6', codigo:'TRN-D006', licitacionId:'demo_l6', licitacionCodigo:'LIC-D006', tipoEquipo:'Cargador frontal - Komatsu', origen:'Santiago', destino:'Antofagasta', precio:3450000,
      estado:'en_ruta', adjudicadoAt:iso(-4*D), ubicacionOrigen:'47RV+HX Pudahuel', oc:doc('OC-4501-demo.pdf',-3*D),
      equipoAsignado:{ patente:'KXTR-45', tipo:'Cama baja 4 ejes', marca:'Volvo', modelo:'FH 540' },
      conductorAsignado:{ nombre:'Luis Contreras', rut:'12.345.678-9', telefono:'+56 9 5555 0404' },
      direcciones:{ carga:{ direccion:'Camino a Noviciado 2300, Pudahuel', horario:'08:00 a 17:00', restricciones:'Ingreso por portón 2' }, descarga:{ direccion:'Av. Pedro Aguirre Cerda 9500, Antofagasta', horario:'08:00 a 18:00', notas:'Avisar 1 hora antes de llegar' } },
      historial:hist([['preparacion','Transporte creado al adjudicar',-4*D],['preparacion','Equipo y conductor asignados',-2*D,TR.c.nombre],['carga_recogida','Equipo cargado y amarrado',-1*D,TR.c.nombre],['en_ruta','En ruta, pasando por La Serena',-6*H,TR.c.nombre]])
    }, conT(TR.c))));

    // 7) Adjudicada → transporte EN PREPARACIÓN
    var c7=cot('demo_c71','demo_l7',TR.a,1250000,0.83,fmtFecha(2*D),fmtFecha(2*D),'Rampla plana','Valparaíso → Santiago',['Seguro de carga'],'',50);
    L.push(lic({ id:'demo_l7', codigo:'LIC-D007', estado:'adjudicada', tipoLicitacion:'carga', tipoEquipo:'Contenedor 40\' HC', tipoCarga:'Contenedor', peso:'26', origen:'Valparaíso', destino:'Santiago',
      fechaCarga:fecha(2*D), fechaEntrega:fecha(2*D), createdAt:iso(-3*D), aprobadaAt:iso(-3*D+H), cierreAt:iso(-2*D), adjudicadaAt:iso(-1*D),
      cotizaciones:[c7], totalCotizaciones:3, adjudicadaA:adj(TR.a,'demo_c71',1250000,fmtFecha(2*D)) }));
    T.push(trn(Object.assign({ id:'demo_t7', codigo:'TRN-D007', licitacionId:'demo_l7', licitacionCodigo:'LIC-D007', tipoEquipo:'Contenedor 40\' HC', origen:'Valparaíso', destino:'Santiago', precio:1250000,
      estado:'preparacion', adjudicadoAt:iso(-1*D),
      historial:hist([['preparacion','Transporte creado al adjudicar',-1*D]])
    }, conT(TR.a))));

    // 8) Adjudicada → ENTREGADO + facturado → POR VALORAR
    var c8=cot('demo_c81','demo_l8',TR.b,780000,0.8,fmtFecha(-5*D),fmtFecha(-4*D),'Cama baja 2 ejes','Rancagua → Talca',['Seguro de carga'],'',80);
    L.push(lic({ id:'demo_l8', codigo:'LIC-D008', estado:'adjudicada', tipoEquipo:'Minicargador', marca:'Bobcat', modelo:'S650', peso:'4', origen:'Rancagua', destino:'Talca',
      fechaCarga:fecha(-5*D), fechaEntrega:fecha(-4*D), createdAt:iso(-10*D), aprobadaAt:iso(-10*D+H), cierreAt:iso(-9*D), adjudicadaAt:iso(-8*D),
      cotizaciones:[c8], totalCotizaciones:3, adjudicadaA:adj(TR.b,'demo_c81',780000,fmtFecha(-4*D)) }));
    T.push(trn(Object.assign({ id:'demo_t8', codigo:'TRN-D008', licitacionId:'demo_l8', licitacionCodigo:'LIC-D008', tipoEquipo:'Minicargador - Bobcat', origen:'Rancagua', destino:'Talca', precio:780000,
      estado:'entregado', estadoDocumentos:'completo', adjudicadoAt:iso(-8*D), entregadoAt:iso(-4*D),
      oc:doc('OC-4488-demo.pdf',-7*D), guiaDespacho:doc('Guia-Despacho-demo.pdf',-5*D), factura:doc('Factura-1022-demo.pdf',-3*D),
      direcciones:{ carga:{ direccion:'Av. Libertador B. O\'Higgins 0850, Rancagua', horario:'08:00 a 13:00' }, descarga:{ direccion:'Obra Demo, 2 Sur 1450, Talca', horario:'09:00 a 18:00', notas:'Descarga con grúa horquilla en obra' } },
      pod:{ fotos:[], receptorNombre:'Andrea Rojas', receptorRut:'15.678.901-2', registradoAt:iso(-4*D), registradoPor:TR.b.nombre },
      equipoAsignado:{ patente:'HJPL-22', tipo:'Cama baja 2 ejes', marca:'Scania', modelo:'R450' },
      conductorAsignado:{ nombre:'Marcelo Díaz', rut:'13.456.789-0', telefono:'+56 9 5555 0505' },
      historial:hist([['preparacion','Transporte creado al adjudicar',-8*D],['carga_recogida','Equipo cargado',-5*D,TR.b.nombre],['en_ruta','En ruta',-5*D+2*H,TR.b.nombre],['en_destino','Llegó a destino',-4*D-3*H,TR.b.nombre],['entregado','Entregado sin observaciones',-4*D,TR.b.nombre]])
    }, conT(TR.b))));

    // 9) Completada + valorada (con respuesta del transportista)
    var c9=cot('demo_c91','demo_l9',TR.c,2100000,0.9,fmtFecha(-15*D),fmtFecha(-13*D),'Cama baja 3 ejes','Santiago → La Serena',['Seguro de carga','Permiso MOP'],'',40);
    var val9={ scores:{ puntualidad:5, comunicacion:5, estadoCarga:5, documentacion:4 }, promedio:4.8, comentario:'Muy buen servicio, llegaron antes de lo acordado.', createdAt:iso(-10*D), respuestaTransportista:'¡Gracias! Fue un gusto trabajar con ustedes.' };
    L.push(lic({ id:'demo_l9', codigo:'LIC-D009', estado:'completada', tipoEquipo:'Motoniveladora', marca:'Caterpillar', modelo:'140K', peso:'16', origen:'Santiago', destino:'La Serena',
      fechaCarga:fecha(-15*D), fechaEntrega:fecha(-13*D), createdAt:iso(-20*D), cierreAt:iso(-19*D), adjudicadaAt:iso(-18*D),
      cotizaciones:[c9], totalCotizaciones:5, adjudicadaA:adj(TR.c,'demo_c91',2100000,fmtFecha(-13*D)), valoracion:val9 }));
    T.push(trn(Object.assign({ id:'demo_t9', codigo:'TRN-D009', licitacionId:'demo_l9', licitacionCodigo:'LIC-D009', tipoEquipo:'Motoniveladora - Caterpillar', origen:'Santiago', destino:'La Serena', precio:2100000,
      estado:'entregado', estadoDocumentos:'completo', adjudicadoAt:iso(-18*D), entregadoAt:iso(-13*D), valoracion:val9,
      oc:doc('OC-4410-demo.pdf',-17*D), guiaDespacho:doc('Guia-Despacho-demo.pdf',-15*D), factura:doc('Factura-0987-demo.pdf',-12*D),
      historial:hist([['preparacion','Transporte creado al adjudicar',-18*D],['en_ruta','En ruta',-15*D,TR.c.nombre],['entregado','Entregado',-13*D,TR.c.nombre]])
    }, conT(TR.c))));

    // 10-15) Historial de meses anteriores (alimenta los gráficos del dashboard)
    var previas=[
      ['demo_l10','Grúa horquilla','Santiago','Valparaíso',650000,TR.a,-35],
      ['demo_l11','Excavadora','Santiago','Rancagua',980000,TR.b,-52],
      ['demo_l12','Rodillo compactador','Talca','Chillán',720000,TR.c,-70],
      ['demo_l13','Camión aljibe','Antofagasta','Mejillones',540000,TR.a,-95],
      ['demo_l14','Retroexcavadora','Santiago','San Antonio',610000,TR.b,-120],
      ['demo_l15','Grúa torre (partes)','Santiago','Rancagua',1850000,TR.c,-150]
    ];
    previas.forEach(function(h,i){
      var d=h[6]*D, cid=h[0]+'_c', n=10+i;
      var v={ scores:{ puntualidad:5, comunicacion:4, estadoCarga:5, documentacion:5 }, promedio:4.7, comentario:'', createdAt:iso(d+3*D) };
      L.push(lic({ id:h[0], codigo:'LIC-D0'+n, estado:'completada', tipoEquipo:h[1], origen:h[2], destino:h[3], fechaCarga:fecha(d+2*D), fechaEntrega:fecha(d+2*D),
        createdAt:iso(d), cierreAt:iso(d+D), adjudicadaAt:iso(d+D+2*H), totalCotizaciones:3+(i%3),
        cotizaciones:[cot(cid,h[0],h[5],h[4],0.8,fmtFecha(d+2*D),fmtFecha(d+2*D),'Cama baja',h[2]+' → '+h[3],['Seguro de carga'],'',60)],
        adjudicadaA:adj(h[5],cid,h[4],fmtFecha(d+2*D)), valoracion:v }));
      T.push(trn(Object.assign({ id:h[0].replace('_l','_t'), codigo:'TRN-D0'+n, licitacionId:h[0], licitacionCodigo:'LIC-D0'+n, tipoEquipo:h[1], origen:h[2], destino:h[3], precio:h[4],
        estado:'entregado', estadoDocumentos:'completo', adjudicadoAt:iso(d+D+2*H), entregadoAt:iso(d+2*D), valoracion:v,
        oc:doc('OC-demo.pdf',d+D), factura:doc('Factura-demo.pdf',d+3*D), historial:hist([['entregado','Entregado',d+2*D,h[5].nombre]])
      }, conT(h[5]))));
    });

    var N=[
      { id:'demo_n1', tipo:'cotizaciones_disponibles', mensaje:'Tienes 3 cotizaciones para comparar: Bulldozer Santiago → Copiapó', leida:false, createdAt:iso(-2*H), datos:{ licitacionId:'demo_l4' } },
      { id:'demo_n2', tipo:'cotizaciones_disponibles', mensaje:'Tienes 3 cotizaciones para comparar: Retroexcavadora Concepción → Los Ángeles', leida:false, createdAt:iso(-1*H), datos:{ licitacionId:'demo_l5' } },
      { id:'demo_n3', tipo:'pregunta_licitacion', mensaje:'Un transportista hizo una pregunta en LIC-D002 (Excavadora)', leida:false, createdAt:iso(-3*H), datos:{ licitacionId:'demo_l2' } },
      { id:'demo_n4', tipo:'transporte_estado', mensaje:'TRN-D006 está en ruta hacia Antofagasta', leida:true, createdAt:iso(-6*H), datos:{ transporteId:'demo_t6' } },
      { id:'demo_n5', tipo:'factura_subida', mensaje:'El transportista subió la factura de TRN-D008. Ya puedes valorarlo.', leida:false, createdAt:iso(-3*D), datos:{ transporteId:'demo_t8' } },
      { id:'demo_n6', tipo:'licitacion_aprobada', mensaje:'Tu licitación LIC-D003 fue aprobada y está publicada', leida:true, createdAt:iso(-19*H), datos:{ licitacionId:'demo_l3' } }
    ];
    return { lics:L, trans:T, notifs:N, seq:100 };
  }

  var S;
  try{ S=JSON.parse(sessionStorage.getItem(KEY)||'null'); }catch(e){ S=null; }
  if(!S||!S.lics) S=seed();
  function save(){ try{ sessionStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} }
  save();

  var ME={ id:CLI.id, email:CLI.email, role:'cliente', nombre:CLI.nombre, empresa:CLI.empresa, comuna:'Las Condes', plan:localStorage.getItem('tm_plan')||'pro', estado:'activo',
    telefono:'+56 9 5555 0000', whatsapp:'+56 9 5555 0000', ciudad:'Santiago', rut:'11.111.111-1', rutEmpresa:'76.000.000-0', cargo:'Jefe de Logística',
    giro:'Construcción de obras civiles', telEmpresa:'+56 2 2555 0000', ciudadEmpresa:'Santiago', direccion:'Av. Apoquindo 4000, Las Condes', web:'www.ejemplo.cl',
    descripcion:'Empresa ficticia para demostración de TransMatch.', industrias:['Construcción','Minería'], zonas:[], equipos:[], tiposEquipo:[],
    facturacion:{ razonSocial:'Constructora Cordillera SpA (Demo)', rut:'76.000.000-0', giro:'Construcción', direccion:'Av. Apoquindo 4000, Las Condes', email:'facturacion@demo.cl' },
    contactos:[], datosBancarios:{}, max_usuarios:5, esSubusuario:false, empresaMadreId:null, rol:'dueno', empresaId:CLI.id, empresaMiembros:[], permisos:{},
    perfilCompletitud:100, notifEmail:true, notifWhatsapp:true, notifPrefs:{} };

  function findL(id){ return S.lics.filter(function(l){ return l.id===id; })[0]; }
  function findT(id){ return S.trans.filter(function(t){ return t.id===id; })[0]; }
  function vistaCot(c, revelar){
    var o={}; for(var k in c){ if(k!=='_t') o[k]=c[k]; }
    if(revelar&&c._t) o.contactoEncargado={ nombre:c._t.nombre, telefono:c._t.tel, email:c._t.email };
    return o;
  }
  function vistaL(l){
    var o=JSON.parse(JSON.stringify(l));
    var adjId=l.adjudicadaA&&l.adjudicadaA.cotizacionId;
    o.cotizaciones=(l.cotizaciones||[]).map(function(c){ return vistaCot(c, c.id===adjId); });
    return o;
  }
  var PDF_B64=btoa('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 70>>stream\nBT /F1 20 Tf 60 760 Td (TransMatch - Documento de demostracion) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  function ahora(){ return new Date().toISOString(); }

  function route(method, path, b){
    var m;
    if(path==='/api/auth/me') return { user:ME };
    if(path==='/api/perfil'){ if(method!=='GET'){ for(var k in b) ME[k]=b[k]; } return { ok:true, user:ME }; }

    // ── Licitaciones
    if(path==='/api/licitaciones'){
      if(method==='GET') return { licitaciones:S.lics.map(vistaL) };
      if(method==='POST'){
        var id='demo_l'+(++S.seq);
        var n=lic(Object.assign({}, b, { id:id, codigo:'LIC-D'+S.seq, estado:'pendiente_admin', tipoEquipo:b.tipoEquipo||b.tipoCarga||'Carga general',
          createdAt:ahora(), cierreAt:new Date(Date.now()+parseInt(b.plazo||'24',10)*H).toISOString(), cotizaciones:[], preguntas:[] }));
        S.lics.unshift(n);
        S.notifs.unshift({ id:'demo_n'+S.seq, tipo:'licitacion_aprobada', mensaje:'Recibimos tu licitación '+n.codigo+'. La estamos revisando.', leida:false, createdAt:ahora(), datos:{ licitacionId:id } });
        return { ok:true, id:id, mensaje:'Licitacion enviada.' };
      }
    }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)$/))){
      var l=findL(m[1]); if(!l) return { __status:404, error:'No encontrada' };
      if(method==='GET') return { licitacion:vistaL(l) };
      if(method==='DELETE'){ S.lics=S.lics.filter(function(x){ return x.id!==l.id; }); return { ok:true }; }
      if(method==='PUT'){ for(var k2 in b) l[k2]=b[k2]; return { ok:true, id:l.id }; }
    }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)\/adjudicar$/))){
      var la=findL(m[1]); if(!la) return { __status:404, error:'No encontrada' };
      var cs=la.cotizaciones||[];
      var c=cs.filter(function(x){ return x.id===b.cotizacionId; })[0];
      if(!c){ var mi=String(b.cotizacionId||'').match(/^cotiz_(\d+)$/); if(mi) c=cs[parseInt(mi[1],10)]; }
      if(!c) return { __status:400, error:'Cotizacion no encontrada' };
      var t=c._t||TR.a;
      la.estado='adjudicada'; la.adjudicadaAt=ahora(); la.adjudicadaA=adj(t,c.id,c.precio,c.tiempoEntrega);
      var tid='demo_t'+(++S.seq);
      S.trans.unshift(trn(Object.assign({ id:tid, codigo:'TRN-D'+S.seq, licitacionId:la.id, licitacionCodigo:la.codigo, tipoEquipo:la.tipoEquipo+(la.marca?' - '+la.marca:''),
        origen:la.origen, destino:la.destino, precio:c.precio, estado:'preparacion', adjudicadoAt:ahora(),
        historial:[{ estado:'preparacion', nota:'Transporte creado al adjudicar', fecha:ahora(), actor:'Sistema' }] }, conT(t))));
      return { ok:true, transporteId:tid };
    }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)\/pregunta\/([^/]+)\/responder$/))){
      var lp=findL(m[1]); var p=lp&&(lp.preguntas||[]).filter(function(x){ return x.id===m[2]; })[0];
      if(p){ p.respuesta=b.respuesta||''; p.respondidaAt=ahora(); }
      return { ok:true };
    }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)\/anular$/))){ var lx=findL(m[1]); if(lx){ lx.estado='anulada'; lx.motivoAnulacion=b.motivo||''; } return { ok:true }; }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)\/ampliar-plazo$/))){ var lz=findL(m[1]); if(lz){ lz.estado='abierta'; lz.cierreAt=new Date(Date.now()+parseInt(b.plazo||'24',10)*H).toISOString(); } return { ok:true }; }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)\/fechas$/))){ var lf=findL(m[1]); if(lf){ for(var k3 in b) lf[k3]=b[k3]; } return { ok:true }; }
    if(path.indexOf('/api/licitaciones/')===0) return { ok:true };

    // ── Transportes
    if(path==='/api/transportes') return { transportes:JSON.parse(JSON.stringify(S.trans)) };
    if((m=path.match(/^\/api\/transportes\/([^/]+)$/))){ var tt=findT(m[1]); return tt?{ transporte:tt }:{ __status:404, error:'No encontrado' }; }
    if((m=path.match(/^\/api\/transportes\/([^/]+)\/(.+)$/))){
      var tr=findT(m[1]); if(!tr) return { __status:404, error:'No encontrado' };
      var acc=m[2];
      if(acc==='incidencia'){ tr.incidenciasCliente=tr.incidenciasCliente||[]; tr.incidenciasCliente.push({ tipo:b.tipo||'Otro', descripcion:b.descripcion||'', createdAt:ahora() }); }
      else if(acc==='direcciones'){ tr.direcciones=Object.assign({}, tr.direcciones||{}, b.direcciones||b); }
      else if(acc==='subir-oc'){ tr.oc={ archivoId:'demo_doc', nombre:b.nombre||b.archivoNombre||'OC.pdf', subidoAt:ahora() }; }
      else if(acc==='subir-guia'){ tr.guiaDespacho={ archivoId:'demo_doc', nombre:b.nombre||b.archivoNombre||'Guia.pdf', subidoAt:ahora() }; }
      return { ok:true, transporte:tr };
    }

    // ── Valoraciones
    if(path==='/api/valoraciones'){
      if(method!=='POST') return { valoraciones:[] };
      var tv=b.transporteId?findT(b.transporteId):null;
      var lv=findL(b.licitacionId||(tv&&tv.licitacionId));
      var vals=b.scores||{}, arr=Object.keys(vals).map(function(k){ return vals[k]; });
      var prom=b.promedio||(arr.length?Math.round(arr.reduce(function(a,x){ return a+x; },0)/arr.length*10)/10:5);
      var v={ scores:vals, promedio:prom, comentario:b.comentario||'', createdAt:ahora() };
      if(tv){ tv.valoracion=v; }
      if(lv){ lv.valoracion=v; lv.estado='completada'; }
      return { ok:true, promedio:prom };
    }

    // ── Notificaciones
    if(path==='/api/notificaciones') return { notificaciones:S.notifs };
    if(path==='/api/notificaciones/leer'){ S.notifs.forEach(function(n){ if(b.todas||n.id===b.id) n.leida=true; }); return { ok:true }; }

    // ── Facturación, empresa, retornos
    if(path==='/api/facturas-suscripcion') return { facturas:[
      { id:'demo_f3', numero:'1003', periodo:'Septiembre 2026', monto:0, fechaEmision:fecha(-2*D), estado:'pendiente', archivoId:'demo_doc', archivoNombre:'Factura-demo-1003.pdf' },
      { id:'demo_f2', numero:'1002', periodo:'Agosto 2026', monto:0, fechaEmision:fecha(-32*D), estado:'pagada', archivoId:'demo_doc', archivoNombre:'Factura-demo-1002.pdf', pagadaAt:iso(-28*D) },
      { id:'demo_f1', numero:'1001', periodo:'Julio 2026', monto:0, fechaEmision:fecha(-62*D), estado:'pagada', archivoId:'demo_doc', archivoNombre:'Factura-demo-1001.pdf', pagadaAt:iso(-58*D) } ] };
    if(path==='/api/mi-empresa/usuarios') return { miembros:[
      { id:'demo_u2', email:'operaciones@demo.cl', nombre:'Felipe Araya', permisos:{}, rol:'miembro', estado:'activo', createdAt:iso(-40*D) },
      { id:'demo_u3', email:'bodega@demo.cl', nombre:'Pedro Soto', permisos:{}, rol:'miembro', estado:'activo', createdAt:iso(-20*D) } ],
      max_usuarios:5, invitacionesPendientes:[] };
    if(path==='/api/retornos') return { retornos:[
      { id:'demo_r1', estado:'disponible', ciudadOrigen:'Antofagasta', ciudadDestino:'Santiago', fechaDesde:fecha(2*D), fechaHasta:fecha(5*D), fecha:fecha(2*D), equipo:'Cama baja 3 ejes', capacidad:'Hasta 30 ton', precio:1400000, descripcion:'Retorno vacío tras entrega en faena.' },
      { id:'demo_r2', estado:'disponible', ciudadOrigen:'Concepción', ciudadDestino:'Santiago', fechaDesde:fecha(1*D), fechaHasta:fecha(3*D), fecha:fecha(1*D), equipo:'Rampla plana', capacidad:'Hasta 25 ton', precio:650000, descripcion:'Disponible para carga general o maquinaria liviana.' } ] };
    if(path==='/api/propuestas') return { propuestas:[] };
    if(/^\/api\/retornos\/[^/]+\/mi-propuesta$/.test(path)) return { propuesta:null };

    // ── Archivos
    if(path==='/api/archivos/upload'){ var aid='demo_arch_'+(++S.seq); return { ok:true, id:aid, archivoId:aid }; }
    if(/^\/api\/archivos\/[^/]+$/.test(path)) return { base64:PDF_B64, mimeType:'application/pdf', nombre:'documento-demo.pdf', archivoNombre:'documento-demo.pdf' };

    return { ok:true };
  }

  // ── Interceptor de fetch ─────────────────────────────────────
  var _fetch=window.fetch.bind(window);
  window.fetch=function(input, init){
    var raw=typeof input==='string'?input:(input&&input.url)||'';
    var u; try{ u=new URL(raw, location.href); }catch(e){ return _fetch(input, init); }
    var esApi=u.pathname.indexOf('/api/')===0 && (u.origin===location.origin || /workers\.dev$/.test(u.hostname));
    if(!esApi) return _fetch(input, init);
    var method=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    var body={}; try{ if(init&&typeof init.body==='string') body=JSON.parse(init.body)||{}; }catch(e){}
    var res; try{ res=route(method, u.pathname, body); }catch(e){ console.warn('[demo]', e); res={ ok:true }; }
    save();
    var status=(res&&res.__status)||200; if(res) delete res.__status;
    return new Promise(function(resolve){
      setTimeout(function(){ resolve(new Response(JSON.stringify(res), { status:status, headers:{ 'Content-Type':'application/json' } })); }, 150);
    });
  };

  // ── Indicador discreto de modo demo ──────────────────────────
  function badge(){
    if(document.getElementById('tm-demo-badge')) return;
    var d=document.createElement('div'); d.id='tm-demo-badge';
    d.innerHTML='MODO DEMO · datos ficticios &nbsp;<a href="/demo.html?reiniciar=1" style="color:#FF8808;text-decoration:none">Reiniciar</a> · <a href="/demo.html?salir=1" style="color:#FF8808;text-decoration:none">Salir</a>';
    d.style.cssText='position:fixed;left:12px;bottom:12px;z-index:99999;background:#1E2D4E;color:#fff;font:600 11px Barlow,sans-serif;letter-spacing:.4px;padding:6px 12px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.2);opacity:.85';
    document.body.appendChild(d);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', badge); else badge();
})();
