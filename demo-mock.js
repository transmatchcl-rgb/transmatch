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

  var ROL=(localStorage.getItem('tm_role')==='transportista')?'transportista':'cliente';
  var KEY=ROL==='transportista'?'tm_demo_state_t_v1':'tm_demo_state_v1';
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
      tipoLicitacion:'maquinaria', tipoEquipoRequerido:'cualquiera', marca:'', modelo:'', cantidadEquipos:'',
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
    var val9={ scores:{ cumplimiento:5, seriedad:5, comunicacion:5, estadoEquipo:5, documentacion:4, velocidad:5 }, promedio:4.8, comentario:'Muy buen servicio, llegaron antes de lo acordado.', createdAt:iso(-10*D), respuestaTransportista:'¡Gracias! Fue un gusto trabajar con ustedes.' };
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
      var v={ scores:{ cumplimiento:5, seriedad:5, comunicacion:4, estadoEquipo:5, documentacion:5, velocidad:4 }, promedio:4.7, comentario:'', createdAt:iso(d+3*D) };
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
  if(!S||!S.lics) S=(ROL==='transportista'?seedT():seed());
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
        return { ok:true, id:id, mensaje:'Licitación enviada.' };
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
      if(!c) return { __status:400, error:'Cotización no encontrada' };
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
      if(acc==='solicitar-documentos'){
        tr.requisitosEstandar=tr.requisitosEstandar||[];
        var ya={}; tr.requisitosEstandar.forEach(function(r){ ya[String(r.label).toLowerCase()]=1; });
        var n=0; (b.documentos||[]).forEach(function(dd){ var lb=String((dd&&dd.label)||dd||'').trim(); if(!lb||ya[lb.toLowerCase()]) return; ya[lb.toLowerCase()]=1; n++;
          tr.requisitosEstandar.push({ id:'demo_req_'+(++S.seq), label:lb, indicaciones:(dd&&dd.indicaciones)||b.indicaciones||'', archivoId:null, solicitadoAt:ahora(), origen:'cliente' }); });
        if(!n) return { __status:400, error:'Esos documentos ya están solicitados' };
        return { ok:true, agregados:n };
      }
      var mq=acc.match(/^requisito\/(.+)$/);
      if(mq&&method==='DELETE'){ tr.requisitosEstandar=(tr.requisitosEstandar||[]).filter(function(r){ return r.id!==mq[1]||r.archivoId; }); return { ok:true }; }
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
    if(path==='/api/mis-informes'){
      var mk=function(back){ var d=new Date(NOW); d.setDate(1); d.setMonth(d.getMonth()-back); var per=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
        var MES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][d.getMonth()]+' '+d.getFullYear(); return { per:per, nom:MES }; };
      var m1=mk(1), m2=mk(2);
      return { razonSocial:CLI.empresa, informes:[
        { periodo:m1.per, nombrePeriodo:m1.nom, informe:{ periodo:m1.per, publicadas:6, cotizacionesPromedio:4.2, adjudicadas:4, montoAdjudicado:9230000, completados:3, valoracionPromedio:4.8,
          rutas:[{ruta:'Santiago → Antofagasta',cantidad:2},{ruta:'Santiago → Copiapó',cantidad:2},{ruta:'Rancagua → Talca',cantidad:1}],
          detalle:[{codigo:'LIC-D006',equipo:'Cargador frontal Komatsu',origen:'Santiago',destino:'Antofagasta',cotizaciones:4,precio:3450000},{codigo:'LIC-D008',equipo:'Minicargador Bobcat',origen:'Rancagua',destino:'Talca',cotizaciones:3,precio:780000},{codigo:'LIC-D009',equipo:'Motoniveladora Caterpillar',origen:'Santiago',destino:'La Serena',cotizaciones:5,precio:2100000},{codigo:'LIC-D011',equipo:'Excavadora',origen:'Santiago',destino:'Rancagua',cotizaciones:4,precio:2900000}], conActividad:true } },
        { periodo:m2.per, nombrePeriodo:m2.nom, informe:{ periodo:m2.per, publicadas:3, cotizacionesPromedio:3.7, adjudicadas:2, montoAdjudicado:1700000, completados:2, valoracionPromedio:4.7,
          rutas:[{ruta:'Talca → Chillán',cantidad:1},{ruta:'Santiago → Rancagua',cantidad:1}],
          detalle:[{codigo:'LIC-D012',equipo:'Rodillo compactador',origen:'Talca',destino:'Chillán',cotizaciones:4,precio:720000},{codigo:'LIC-D011',equipo:'Excavadora',origen:'Santiago',destino:'Rancagua',cotizaciones:3,precio:980000}], conActividad:true } } ] };
    }

    // ── Archivos
    if(path==='/api/archivos/upload'){ var aid='demo_arch_'+(++S.seq); return { ok:true, id:aid, archivoId:aid }; }
    if(/^\/api\/archivos\/[^/]+$/.test(path)) return { base64:PDF_B64, mimeType:'application/pdf', nombre:'documento-demo.pdf', archivoNombre:'documento-demo.pdf' };

    return { ok:true };
  }

  // ══════════════════════════════════════════════════════════════
  //  PORTAL TRANSPORTISTA (demo.html?rol=transportista)
  //  El usuario demo es "Transportes Altiplano (Demo)" = TR.a
  // ══════════════════════════════════════════════════════════════
  function yoT(){ return { id:'demo_transp', email:TR.a.email, nombre:TR.a.nombre, empresa:TR.a.empresa, tel:TR.a.tel, rating:TR.a.rating, total:TR.a.total }; }
  function cotMia(id, licId, precio, fCarga, fEntrega, equipo, ruta, minResp){
    var c=cot(id, licId, TR.a, precio, 0.8, fCarga, fEntrega, equipo, ruta, ['Seguro de carga','Permiso MOP'], 'Incluye amarre y aseguramiento de carga.', minResp);
    var y=yoT(); c.transportistaId=y.id; c.transportistaEmail=y.email; c.transportistaNombre=y.nombre; c.transportistaEmpresa=y.empresa; c.transportistaTelefono=y.tel;
    c.codigo='COT-'+id.slice(-4).toUpperCase(); delete c._t; return c;
  }
  function cotOtro(id, licId, t, precio, fEntrega){
    var c=cot(id, licId, t, precio, 0.7, fEntrega, fEntrega, 'Cama baja', '', ['Seguro de carga'], '', 120);
    c.transportistaId='demo_'+t.email; c.transportistaEmail=t.email; delete c._t; return c;
  }
  function seedT(){
    var L=[], T=[], O=[];
    var yo=yoT();
    // Abiertas (para cotizar)
    L.push(lic({ id:'demo_tl1', codigo:'LIC-D021', estado:'abierta', tipoEquipo:'Excavadora', marca:'Caterpillar', modelo:'320 GC', peso:'22', dimensiones:'9,5 x 3,0 x 3,1 m',
      descripcion:'Excavadora sobre orugas. Requiere cama baja y permiso de sobredimensión.', origen:'Santiago', destino:'Los Andes', direccionOrigen:'Camino a Noviciado 2300, Pudahuel', direccionDestino:'Ruta 60 CH km 12, Los Andes',
      ubicacionOrigen:'https://maps.app.goo.gl/demoPudahuel', ubicacionDestino:'5FQ2+7M Los Andes',
      fechaCarga:fecha(3*D), fechaEntrega:fecha(3*D), createdAt:iso(-6*H), aprobadaAt:iso(-5*H), cierreAt:iso(18*H),
      cotizaciones:[cotOtro('demo_tc1x','demo_tl1',TR.b,1850000,fmtFecha(3*D))],
      preguntas:[{ id:'demo_tp1', texto:'¿El punto de carga tiene acceso para cama baja de 3 ejes?', respuesta:'Sí, acceso por portón 2, sin restricción de altura.', createdAt:iso(-4*H), respondidaAt:iso(-3*H), transportistaId:'otro' }] }));
    L.push(lic({ id:'demo_tl2', codigo:'LIC-D022', estado:'abierta', tipoLicitacion:'carga', tipoEquipo:'Generador eléctrico', tipoCarga:'Carga general', peso:'6,5', dimensiones:'4,8 x 1,6 x 2,2 m',
      descripcion:'Generador 500 kVA en skid, con puntos de izaje.', origen:'Antofagasta', destino:'Calama', direccionOrigen:'Av. Pedro Aguirre Cerda 9500, Antofagasta', direccionDestino:'Faena Demo, km 1350 Ruta 25',
      fechaCarga:fecha(5*D), fechaEntrega:fecha(5*D), createdAt:iso(-20*H), aprobadaAt:iso(-19*H), cierreAt:iso(28*H), plazo:'48',
      requiereEstandar:true, estandarDetalle:'Ingreso a faena minera', estandarRequisitos:[{id:'r1',label:'Certificado de revisión técnica'},{id:'r2',label:'Seguro de carga vigente'},{id:'r3',label:'Licencia A5 del conductor'}],
      cotizaciones:[cotMia('demo_tc2','demo_tl2',1320000,fmtFecha(5*D),fmtFecha(5*D),'Rampla plana','Antofagasta → Calama',180)] }));
    L.push(lic({ id:'demo_tl3', codigo:'LIC-D023', estado:'abierta', tipoEquipo:'Grúa horquilla', marca:'Toyota', modelo:'8FG50', peso:'7', dimensiones:'4,2 x 1,9 x 2,6 m',
      descripcion:'Grúa horquilla operativa, se carga con rampa.', origen:'Rancagua', destino:'Talca', direccionOrigen:'Camino Longitudinal Sur km 88, Rancagua', direccionDestino:'2 Sur 1450, Talca',
      fechaCarga:fecha(2*D), fechaEntrega:fecha(2*D), createdAt:iso(-2*H), aprobadaAt:iso(-1*H), cierreAt:iso(6*H), plazo:'8' }));
    // En decisión (cerrada) con mi cotización
    L.push(lic({ id:'demo_tl4', codigo:'LIC-D024', estado:'cerrada', tipoEquipo:'Bulldozer', marca:'Caterpillar', modelo:'D6T', peso:'23', origen:'Santiago', destino:'Copiapó',
      fechaCarga:fecha(2*D), fechaEntrega:fecha(4*D), createdAt:iso(-2*D), aprobadaAt:iso(-2*D+H), cierreAt:iso(-2*H),
      cotizaciones:[cotMia('demo_tc4','demo_tl4',2690000,fmtFecha(2*D),fmtFecha(5*D),'Cama baja 3 ejes','Santiago → Copiapó',180), cotOtro('demo_tc4x','demo_tl4',TR.c,2850000,fmtFecha(4*D))] }));

    // Adjudicadas a mí + sus transportes
    function ganada(lid, cod, tipo, marca, ori, des, precio, dCarga, dEnt, extraL, tr){
      var cid=lid+'_c';
      var c=cotMia(cid, lid, precio, fmtFecha(dCarga), fmtFecha(dEnt), 'Cama baja', ori+' → '+des, 60);
      L.push(lic(Object.assign({ id:lid, codigo:cod, estado:'adjudicada', tipoEquipo:tipo, marca:marca, origen:ori, destino:des, fechaCarga:fecha(dCarga), fechaEntrega:fecha(dEnt),
        createdAt:iso(dCarga-5*D), aprobadaAt:iso(dCarga-5*D+H), cierreAt:iso(dCarga-4*D), adjudicadaAt:iso(dCarga-3*D), cotizaciones:[c], totalCotizaciones:3,
        adjudicadaA:{ cotizacionId:cid, precio:precio, transportistaId:yo.id, transportistaNombre:yo.nombre, transportistaEmpresa:yo.empresa, transportistaEmail:yo.email, transportistaTelefono:yo.tel, tiempoEntrega:fmtFecha(dEnt) } }, extraL||{})));
      var t=trn(Object.assign({ id:lid.replace('_tl','_tt'), codigo:cod.replace('LIC','TRN'), licitacionId:lid, licitacionCodigo:cod, tipoEquipo:tipo+(marca?' - '+marca:''), origen:ori, destino:des, precio:precio,
        adjudicadoAt:iso(dCarga-3*D), puedoGestionar:true, asignadoNombre:yo.nombre,
        clienteFacturacion:{ razonSocial:'Constructora Cordillera SpA (Demo)', rut:'76.000.000-0', giro:'Construcción', direccion:'Av. Apoquindo 4000, Las Condes', email:'facturacion@demo.cl', telefono:'+56 2 2555 0000' },
        contactoEncargado:{ nombre:yo.nombre, telefono:yo.tel, email:yo.email } }, conT(TR.a), tr||{}));
      T.push(t);
      O.push({ id_ov:'OV-D'+cod.slice(-3), id_transporte:t.id, id_transportista:yo.id, transportistaEmpresa:yo.empresa, id_cliente:CLI.id, clienteEmpresa:'Constructora Cordillera (Demo)', id_licitacion:lid,
        estado:'CONDICIONAL', monto_cotizado:precio, monto_facturado:null, comision_estimada:Math.round(precio*0.05), comision_porcentaje:5, comision_tope_uf:10, comision_final:null,
        fecha_adjudicacion:iso(dCarga-3*D), historial:[{ estado:'CONDICIONAL', fecha:iso(dCarga-3*D), actor:'sistema', nota:'OV creada al adjudicar licitación' }] });
      return t;
    }
    ganada('demo_tl5','LIC-D025','Contenedor 40\' HC','','Valparaíso','Santiago',1250000,2*D,2*D,{ tipoLicitacion:'carga', tipoCarga:'Contenedor' },{
      estado:'preparacion', ubicacionOrigen:'https://maps.app.goo.gl/demoPuertoValpo',
      requisitosEstandar:[
        { id:'demo_rq1', label:'Seguro de carga vigente', archivoId:'demo_doc', archivoNombre:'Seguro-demo.pdf', subidoAt:iso(-1*D) },
        { id:'demo_rq2', label:'Revisión técnica', indicaciones:'Del camión y del semirremolque', archivoId:null, solicitadoAt:iso(-3*H), origen:'cliente' },
        { id:'demo_rq3', label:'Certificado de inducción en faena', indicaciones:'Lo pide prevención de riesgos', archivoId:null, solicitadoAt:iso(-3*H), origen:'cliente' } ],
      direcciones:{ carga:{ direccion:'Terminal Pacífico Sur, Valparaíso', horario:'08:00 a 16:00', restricciones:'Presentar EIR en portería', ubicacion:'https://maps.app.goo.gl/demoPuertoValpo' }, descarga:{ direccion:'Camino a Noviciado 2300, Pudahuel', horario:'08:00 a 17:00', ubicacion:'47RV+HX Pudahuel' } },
      historial:hist([['preparacion','Transporte creado al adjudicar',-1*D],['preparacion','Documentos solicitados por el cliente: Revisión técnica, Certificado de inducción en faena',-3*H,CLI.nombre]]) });
    ganada('demo_tl6','LIC-D026','Cargador frontal','Komatsu','Santiago','Antofagasta',3450000,-1*D,1*D,null,{
      estado:'en_ruta', oc:doc('OC-4501-demo.pdf',-3*D),
      equipoAsignado:{ patente:'KXTR-45', tipo:'Cama baja 4 ejes', marca:'Volvo', modelo:'FH 540' },
      conductorAsignado:{ nombre:'Luis Contreras', rut:'12.345.678-9', telefono:'+56 9 5555 0404' },
      direcciones:{ carga:{ direccion:'Camino a Noviciado 2300, Pudahuel', horario:'08:00 a 17:00', ubicacion:'47RV+HX Pudahuel' }, descarga:{ direccion:'Av. Pedro Aguirre Cerda 9500, Antofagasta', horario:'08:00 a 18:00', notas:'Avisar 1 hora antes' } },
      historial:hist([['preparacion','Transporte creado al adjudicar',-4*D],['carga_recogida','Equipo cargado',-1*D,TR.a.nombre],['en_ruta','En ruta',-6*H,TR.a.nombre]]) });
    ganada('demo_tl7','LIC-D027','Minicargador','Bobcat','Rancagua','Talca',780000,-5*D,-4*D,null,{
      estado:'entregado', entregadoAt:iso(-4*D), oc:doc('OC-4488-demo.pdf',-7*D), guiaDespacho:doc('Guia-demo.pdf',-5*D),
      equipoAsignado:{ patente:'HJPL-22', tipo:'Cama baja 2 ejes', marca:'Scania', modelo:'R450' },
      conductorAsignado:{ nombre:'Marcelo Díaz', rut:'13.456.789-0', telefono:'+56 9 5555 0505' },
      historial:hist([['preparacion','Transporte creado al adjudicar',-8*D],['en_ruta','En ruta',-5*D,TR.a.nombre],['entregado','Entregado sin observaciones',-4*D,TR.a.nombre]]) });
    var v8={ scores:{ cumplimiento:5, seriedad:5, comunicacion:5, estadoEquipo:5, documentacion:4, velocidad:5 }, promedio:4.8, comentario:'Muy buen servicio, llegaron antes de lo acordado.', createdAt:iso(-10*D) };
    ganada('demo_tl8','LIC-D028','Motoniveladora','Caterpillar','Santiago','La Serena',2100000,-15*D,-13*D,{ estado:'completada', valoracion:v8 },{
      estado:'completado', estadoDocumentos:'completo', entregadoAt:iso(-13*D), valoracion:v8, oc:doc('OC-4410-demo.pdf',-17*D), factura:doc('Factura-0987-demo.pdf',-12*D),
      pagoCliente:{ estado:'pagado', marcadoAt:iso(-5*D) },
      historial:hist([['preparacion','Transporte creado al adjudicar',-18*D],['en_ruta','En ruta',-15*D,TR.a.nombre],['entregado','Entregado',-13*D,TR.a.nombre]]) });
    O[3].estado='PAGADA'; O[3].monto_facturado=2100000; O[3].comision_final=105000; O[3].fecha_pago_confirmado=iso(-4*D);

    // Perdida (solo historial, con feedback de posición)
    L.push(lic({ id:'demo_tl9', codigo:'LIC-D029', estado:'adjudicada', tipoEquipo:'Retroexcavadora', marca:'JCB', origen:'Concepción', destino:'Los Ángeles',
      fechaCarga:fecha(-6*D), fechaEntrega:fecha(-6*D), createdAt:iso(-12*D), cierreAt:iso(-11*D), adjudicadaAt:iso(-10*D),
      cotizaciones:[cotMia('demo_tc9','demo_tl9',960000,fmtFecha(-6*D),fmtFecha(-6*D),'Cama baja 2 ejes','Concepción → Los Ángeles',130), cotOtro('demo_tc9b','demo_tl9',TR.b,890000,fmtFecha(-6*D)), cotOtro('demo_tc9c','demo_tl9',TR.c,1050000,fmtFecha(-5*D))],
      adjudicadaA:{ cotizacionId:'demo_tc9b', precio:890000, transportistaEmail:TR.b.email } }));

    var N=[
      { id:'demo_tn1', tipo:'documentos_solicitados', mensaje:'El cliente solicitó 2 documentos para el transporte TRN-D025: Revisión técnica, Certificado de inducción en faena', leida:false, createdAt:iso(-3*H), datos:{ transporteId:'demo_tt5' } },
      { id:'demo_tn2', tipo:'nueva_licitacion', mensaje:'Nueva licitación: Grúa horquilla Rancagua → Talca', leida:false, createdAt:iso(-1*H), datos:{ licitacionId:'demo_tl3' } },
      { id:'demo_tn3', tipo:'adjudicacion', mensaje:'¡Ganaste! Contenedor 40\' HC Valparaíso → Santiago · $1.250.000', leida:false, createdAt:iso(-1*D), datos:{ licitacionId:'demo_tl5' } },
      { id:'demo_tn4', tipo:'valoracion_recibida', mensaje:'Recibiste una valoración de 4.8 en TRN-D028', leida:true, createdAt:iso(-10*D), datos:{ transporteId:'demo_tt8' } }
    ];
    return { lics:L, trans:T, notifs:N, ovs:O, seq:500,
      equipos:[
        { id:'demo_eq1', tipo:'Cama baja 3 ejes', marca:'Volvo', modelo:'FH 540', ano:'2021', capacidadMax:35, largoMax:14, anchoMax:3.2, altoMax:1, patente:'KXTR-45', descripcion:'Con rampas hidráulicas' },
        { id:'demo_eq2', tipo:'Rampla plana', marca:'Scania', modelo:'R450', ano:'2019', capacidadMax:28, largoMax:13.5, anchoMax:2.6, altoMax:1.4, patente:'HJPL-22', descripcion:'' } ],
      conductores:[
        { id:'demo_cd1', nombre:'Luis Contreras', rut:'12.345.678-9', telefono:'+56 9 5555 0404', createdAt:iso(-90*D) },
        { id:'demo_cd2', nombre:'Marcelo Díaz', rut:'13.456.789-0', telefono:'+56 9 5555 0505', createdAt:iso(-60*D) } ],
      retornos:[
        { id:'demo_tr1', estado:'disponible', ciudadOrigen:'Antofagasta', ciudadDestino:'Santiago', fechaDesde:fecha(2*D), fechaHasta:fecha(5*D), fecha:fecha(2*D), equipo:'Cama baja 3 ejes', capacidad:'Hasta 30 ton', precio:1400000, descripcion:'Retorno vacío tras entrega en faena.', transportistaEmail:TR.a.email, createdAt:iso(-1*D) } ]
    };
  }

  var MET={ id:'demo_transp', email:TR.a.email, role:'transportista', nombre:TR.a.nombre, empresa:TR.a.empresa, comuna:'Quilicura', plan:null, rating:TR.a.rating, totalTransportes:TR.a.total, estado:'activo',
    telefono:TR.a.tel, whatsapp:TR.a.tel, ciudad:'Santiago', rut:'12.222.333-4', rutEmpresa:'77.000.000-1', cargo:'Gerente de operaciones', giro:'Transporte de carga por carretera',
    telEmpresa:'+56 2 2555 1111', ciudadEmpresa:'Santiago', direccion:'Av. Américo Vespucio 1200, Quilicura', web:'', descripcion:'Empresa ficticia para demostración de TransMatch.',
    anosExperiencia:12, zonas:['Región Metropolitana','Valparaíso','Antofagasta','Atacama'], equipos:[], tiposEquipo:['Cama baja','Rampla plana'], industrias:['Minería','Construcción'],
    facturacion:{}, contactos:[], datosBancarios:{ banco:'Banco Demo', tipoCuenta:'Cuenta corriente', numero:'00000000', titular:'Transportes Altiplano (Demo)' },
    max_usuarios:3, esSubusuario:false, empresaMadreId:null, rol:'dueno', empresaId:'demo_transp', empresaMiembros:[], permisos:{}, perfilCompletitud:95,
    notifEmail:true, notifWhatsapp:false, notifPrefs:{}, totalCotizaciones:48 };

  function vistaLT(l){
    var o=JSON.parse(JSON.stringify(l));
    var mias=(l.cotizaciones||[]).filter(function(c){ return c.transportistaId==='demo_transp'; });
    var gane=l.adjudicadaA&&l.adjudicadaA.transportistaEmail===TR.a.email;
    if(!gane){
      o.clienteEmpresa='Empresa verificada TransMatch';
      ['clienteEmail','clienteNombre','clienteTelefono','contactoOrigenNombre','contactoOrigenTelefono','contactoOrigenEmail','contactoDestinoNombre','contactoDestinoTelefono','contactoDestinoEmail','creadoPorEmail','creadoPorNombre'].forEach(function(k){ delete o[k]; });
    }
    o.cotizaciones=mias;
    o.empresaYaCotizo=mias.length>0; o.empresaCotizoNombre=mias.length?TR.a.nombre:'';
    o.preguntas=(l.preguntas||[]).map(function(p){ return { id:p.id, texto:p.texto, respuesta:p.respuesta||null, createdAt:p.createdAt, respondidaAt:p.respondidaAt||null, esTuya:p.transportistaId==='demo_transp' }; });
    return o;
  }
  function findTT(id){ return S.trans.filter(function(t){ return t.id===id; })[0]; }

  function routeT(method, path, b){
    var m;
    if(path==='/api/auth/me') return { user:MET };
    if(path==='/api/auth/me/prefs') return { ok:true };
    if(path==='/api/perfil'){ if(method!=='GET'){ for(var k in b) MET[k]=b[k]; } return { ok:true, user:MET }; }

    if(path==='/api/licitaciones' && method==='GET'){
      var out=[];
      S.lics.forEach(function(l){
        var gane=l.adjudicadaA&&l.adjudicadaA.transportistaEmail===TR.a.email;
        if(l.estado==='abierta'||l.estado==='cerrada') out.push(vistaLT(l));
        else if((l.estado==='adjudicada'||l.estado==='completada')&&gane) out.push(vistaLT(l));
      });
      return { licitaciones:out };
    }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)$/))&&method==='GET'){ var l0=findL(m[1]); return l0?{ licitacion:vistaLT(l0) }:{ __status:404, error:'No encontrada' }; }
    if((m=path.match(/^\/api\/licitaciones\/([^/]+)\/pregunta$/))){
      var lp=findL(m[1]); if(lp){ lp.preguntas=lp.preguntas||[]; lp.preguntas.push({ id:'demo_tp'+(++S.seq), texto:b.texto||b.pregunta||'', respuesta:null, createdAt:ahora(), transportistaId:'demo_transp' }); }
      return { ok:true };
    }
    if(path==='/api/cotizaciones' && method==='POST'){
      var lc=findL(b.licitacionId); if(!lc) return { __status:404, error:'No encontrada' };
      if(lc.estado!=='abierta') return { __status:400, error:'Esta licitación no está abierta' };
      var mias=(lc.cotizaciones||[]).filter(function(c){ return c.transportistaId==='demo_transp'; });
      if(mias.length>=2) return { __status:400, error:'Ya enviaste el máximo de 2 cotizaciones para esta licitación' };
      var nc=cotMia('demo_tc'+(++S.seq), lc.id, parseFloat(b.precio)||0, b.fechaCargaISO||'', b.fechaEntregaISO||b.tiempoEntrega||'', (b.formulario&&b.formulario.equipoUtilizado)||'', lc.origen+' → '+lc.destino, 1);
      nc.formulario=b.formulario||nc.formulario; nc.descripcion=b.descripcion||''; nc.incluye=b.incluye||[]; nc.modalidad=b.modalidad||''; nc.createdAt=ahora();
      lc.cotizaciones=(lc.cotizaciones||[]).concat([nc]);
      return { ok:true, mensaje:'Cotización enviada.' };
    }
    if(path==='/api/cotizaciones/eliminar'){
      var le=findL(b.licitacionId); if(le) le.cotizaciones=(le.cotizaciones||[]).filter(function(c){ return !(c.transportistaId==='demo_transp' && (!b.cotizacionId||c.id===b.cotizacionId)); });
      return { ok:true };
    }
    if((m=path.match(/^\/api\/cotizaciones\/mia\/([^/?]+)/))){
      var lm=findL(m[1]); var mc=lm&&(lm.cotizaciones||[]).filter(function(c){ return c.transportistaId==='demo_transp'; })[0];
      return mc?{ cotizacion:mc }:{ __status:404, error:'No tienes una cotización en esta licitación' };
    }
    if(path==='/api/transportista/historial'){
      var res=[];
      S.lics.forEach(function(l){
        var mi=(l.cotizaciones||[]).filter(function(c){ return c.transportistaId==='demo_transp'; })[0];
        var gane=l.adjudicadaA&&l.adjudicadaA.transportistaEmail===TR.a.email;
        if(!mi&&!gane) return;
        var pp=null,pe=null,pv=null,tot=null;
        if(mi&&!gane&&(l.estado==='adjudicada'||l.estado==='completada')){
          var cs=l.cotizaciones||[]; tot=cs.length;
          pp=cs.slice().sort(function(a,b){return a.precio-b.precio;}).indexOf(mi)+1;
          pe=2; pv=cs.slice().sort(function(a,b){return (b.transportistaRating||0)-(a.transportistaRating||0);}).indexOf(mi)+1;
        }
        res.push({ id:l.id, codigo:l.codigo, tipoEquipo:l.tipoEquipo, marca:l.marca, origen:l.origen, destino:l.destino, estado:l.estado, createdAt:l.createdAt, adjudicadaAt:l.adjudicadaAt,
          miCotizacion:mi?{ id:mi.id, precio:mi.precio, tiempoEntrega:mi.tiempoEntrega, score:mi.score, createdAt:mi.createdAt, creadoPor:TR.a.nombre }:null,
          gane:!!gane, precioAdjudicado:gane?l.adjudicadaA.precio:null, valoracion:gane?(l.valoracion||null):null, posPrecio:pp, posEntrega:pe, posValoracion:pv, totalCotizaciones:tot });
      });
      return { licitaciones:res };
    }

    if(path==='/api/transportes') return { transportes:JSON.parse(JSON.stringify(S.trans)) };
    if((m=path.match(/^\/api\/transportes\/([^/]+)$/))){
      var t0=findTT(m[1]); if(!t0) return { __status:404, error:'No encontrado' };
      var o=JSON.parse(JSON.stringify(t0)); o.puedoGestionar=true; o.miembrosEmpresa=[{ email:TR.a.email, nombre:TR.a.nombre, esMadre:true }]; o.asignadoEmailActual=TR.a.email;
      return { transporte:o };
    }
    if((m=path.match(/^\/api\/transportes\/([^/]+)\/(.+)$/))){
      var t=findTT(m[1]); if(!t) return { __status:404, error:'No encontrado' };
      var acc=m[2], now=ahora();
      function h(nota){ t.historial=t.historial||[]; t.historial.push({ estado:t.estado, nota:nota, fecha:now, actor:TR.a.nombre }); }
      if(acc==='estado'){ t.estado=b.estado||t.estado; if(t.estado==='entregado') t.entregadoAt=now; h(b.nota||''); return { ok:true, estado:t.estado }; }
      if(acc==='equipo'){ if(!b.patente) return { __status:400, error:'patente requerida' }; t.equipoAsignado={ patente:b.patente, tipo:b.tipo||'', marca:b.marca||'', modelo:b.modelo||'', equipoId:b.equipoId||null, documentos:b.documentos||null }; h('Equipo asignado: '+b.patente); return { ok:true }; }
      if(acc==='conductor'){ if(!b.nombre||!b.rut) return { __status:400, error:'nombre y rut requeridos' }; t.conductorAsignado=Object.assign({}, b); h('Conductor asignado: '+b.nombre); return { ok:true }; }
      var mr=acc.match(/^requisito\/(.+)$/);
      if(mr&&method==='POST'){ var rq=(t.requisitosEstandar||[]).filter(function(r){ return r.id===mr[1]; })[0]; if(!rq) return { __status:404, error:'Requisito no encontrado' };
        rq.archivoId='demo_doc'; rq.archivoNombre=b.nombre||'documento.pdf'; rq.subidoAt=now; rq.subidoPor=TR.a.nombre; h('Documento de requisito cargado: '+rq.label); return { ok:true, requisito:rq }; }
      if(acc==='documento-extra'&&method==='POST'){ if(!b.label) return { __status:400, error:'Indica un nombre para el documento (ej: Seguro de carga)' };
        var dx={ id:'demo_dx'+(++S.seq), label:String(b.label).slice(0,80), archivoId:'demo_doc', archivoNombre:b.nombre||'documento.pdf', subidoAt:now, subidoPor:TR.a.nombre };
        t.documentosExtra=(t.documentosExtra||[]).concat([dx]); h('Documento agregado: '+dx.label); return { ok:true, documento:dx }; }
      var md=acc.match(/^documento-extra\/(.+)$/);
      if(md){ t.documentosExtra=(t.documentosExtra||[]).filter(function(d){ return d.id!==md[1]; }); return { ok:true }; }
      if(acc==='subir-factura'){ t.factura={ archivoId:'demo_doc', nombre:b.nombre||'factura.pdf', subidoAt:now }; t.estado='completado'; t.completadoAt=now; t.estadoDocumentos='completo'; return { ok:true }; }
      if(acc==='pod'){ t.pod={ fotos:[], receptorNombre:b.receptorNombre||'', receptorRut:b.receptorRut||'', registradoAt:now, registradoPor:TR.a.nombre }; return { ok:true, pod:t.pod }; }
      if(acc==='incidencia'){ t.incidenciasTransportista=(t.incidenciasTransportista||[]).concat([{ id:'demo_in'+(++S.seq), tipo:b.tipo||'Otro', descripcion:b.descripcion||'', createdAt:now }]); return { ok:true }; }
      if(acc==='valoracion/responder'){ if(t.valoracion) t.valoracion.respuestaTransportista=String(b.respuesta||'').slice(0,500); return { ok:true }; }
      if(acc==='pago-cliente'){ t.pagoCliente={ estado:b.estado==='pagado'?'pagado':'pendiente', marcadoAt:now }; return { ok:true }; }
      if(acc==='contacto-operacional'&&method==='POST'){ t.contactosOperacionales=t.contactosOperacionales||{}; t.contactosOperacionales.transportista=(t.contactosOperacionales.transportista||[]).concat([{ nombre:b.nombre||'', cargo:b.cargo||'', telefono:b.telefono||'', email:b.email||'' }]); return { ok:true }; }
      return { ok:true };
    }

    if(path==='/api/mis-ordenes-venta') return { ordenes:S.ovs||[] };
    if(path==='/api/mis-facturas-transmatch') return { facturas:[] };
    if(path==='/api/equipos'){ if(method==='POST'){ var e={ id:'demo_eq'+(++S.seq) }; for(var k2 in b) e[k2]=b[k2]; S.equipos.push(e); return { ok:true, id:e.id }; } return { equipos:S.equipos }; }
    if((m=path.match(/^\/api\/equipos\/([^/]+)$/))){ if(method==='DELETE') S.equipos=S.equipos.filter(function(e){ return e.id!==m[1]; }); else { var eq=S.equipos.filter(function(e){ return e.id===m[1]; })[0]; if(eq) for(var k3 in b) eq[k3]=b[k3]; } return { ok:true }; }
    if(path==='/api/conductores'){ if(method==='POST'){ var c2={ id:'demo_cd'+(++S.seq), createdAt:ahora() }; for(var k4 in b) c2[k4]=b[k4]; S.conductores.push(c2); return { ok:true, id:c2.id }; } return { conductores:S.conductores }; }
    if((m=path.match(/^\/api\/conductores\/([^/]+)$/))){ if(method==='DELETE') S.conductores=S.conductores.filter(function(c){ return c.id!==m[1]; }); else { var cd=S.conductores.filter(function(c){ return c.id===m[1]; })[0]; if(cd) for(var k5 in b) cd[k5]=b[k5]; } return { ok:true }; }
    if(path==='/api/retornos'){ if(method==='POST'){ var r={ id:'demo_tr'+(++S.seq), estado:'disponible', transportistaEmail:TR.a.email, createdAt:ahora() }; for(var k6 in b) r[k6]=b[k6]; S.retornos.unshift(r); return { ok:true, id:r.id }; } return { retornos:S.retornos, _fuente:'demo' }; }
    if(/^\/api\/retornos\/[^/]+\/propuestas$/.test(path)) return { propuestas:[] };
    if((m=path.match(/^\/api\/retornos\/([^/]+)$/))){ if(method==='DELETE') S.retornos=S.retornos.filter(function(r){ return r.id!==m[1]; }); return { ok:true }; }
    if(path==='/api/propuestas') return { propuestas:[] };
    if(path==='/api/mi-empresa/usuarios') return { miembros:[{ id:'demo_tu2', email:'despacho@demo.cl', nombre:'Paula Rivas', permisos:{}, rol:'miembro', estado:'activo', createdAt:iso(-30*D) }], max_usuarios:3, invitacionesPendientes:[] };

    if(path==='/api/notificaciones') return { notificaciones:S.notifs };
    if(path==='/api/notificaciones/leer'){ S.notifs.forEach(function(n){ if(b.todas||n.id===b.id) n.leida=true; }); return { ok:true }; }
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
    var res; try{ res=(ROL==='transportista'?routeT:route)(method, u.pathname, body); }catch(e){ console.warn('[demo]', e); res={ ok:true }; }
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
    d.innerHTML='MODO DEMO · datos ficticios &nbsp;<a href="/demo.html?reiniciar=1'+(ROL==='transportista'?'&rol=transportista':'')+'" style="color:#FF8808;text-decoration:none">Reiniciar</a> · <a href="/demo.html?salir=1" style="color:#FF8808;text-decoration:none">Salir</a>';
    d.style.cssText='position:fixed;left:12px;bottom:12px;z-index:99999;background:#1E2D4E;color:#fff;font:600 11px Barlow,sans-serif;letter-spacing:.4px;padding:6px 12px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.2);opacity:.85';
    document.body.appendChild(d);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', badge); else badge();
})();
