/* TransMatch — Guía paso a paso dentro de la plataforma.
   Botón "¿Cómo funciona?" + recorrido que resalta los elementos reales de cada página.
   Se abre sola la primera vez que se visita cada página (por navegador). Nunca bloquea nada. */
(function(){
  var NAV=function(p){ return 'a.nav-link[href="/'+p+'.html"]'; };
  var G={
    'cliente':[
      {t:'Tu resumen',d:'Aquí ves cuántas licitaciones tienes activas, adjudicadas y tu tasa de adjudicación.',s:'#kpi-abiertas',up:'.stat'},
      {t:'Publica una licitación',d:'Pulsa aquí cuando necesites transportar algo. Completas equipo, ruta y fechas, y TransMatch avisa a los transportistas que calzan.',x:'Nueva licitación'},
      {t:'Tus licitaciones',d:'Sigue el estado de cada solicitud y compara las cotizaciones cuando cierre el plazo.',s:NAV('cliente-licitaciones')},
      {t:'Tus transportes',d:'Cada licitación adjudicada crea un transporte: contacto del transportista, documentos y facturas en un solo lugar.',s:NAV('cliente-transporte')},
      {t:'Tu cuenta',d:'En el menú con tu nombre configuras los datos de tu empresa, facturación e invitas a tu equipo.',s:'[onclick*="toggleUserMenu"]'}
    ],
    'cliente-licitaciones':[
      {t:'Nueva licitación',d:'Desde aquí publicas una nueva solicitud de transporte.',x:'Nueva licitación'},
      {t:'Filtra por estado',d:'En revisión: TransMatch la está revisando. Abierta: los transportistas están cotizando. Con cotizaciones: ya puedes elegir.',s:'[onclick*="togglePill"]'},
      {t:'Abre una licitación',d:'Haz clic para ver el detalle, responder preguntas de transportistas, ampliar el plazo y, cuando haya cotizaciones, compararlas y adjudicar.',s:'[onclick*="abrirDetalle"]'},
      {t:'Más opciones',d:'En el menú ⋯ puedes editar, duplicar o anular una licitación mientras no esté adjudicada.',s:'[onclick*="togglePanelMenu"]'}
    ],
    'cliente-nueva':[
      {t:'¿Qué necesitas transportar?',d:'Elige el tipo: maquinaria pesada, carga general o contenedores.',x:'Maquinaria pesada'},
      {t:'4 pasos simples',d:'Equipo, Ruta y fechas, Configuración y Confirmar. Mientras más detalle entregues (fotos, ficha técnica, accesos), mejores cotizaciones recibirás.'},
      {t:'Plazo para cotizar',d:'En Configuración eliges cuánto tiempo tienen los transportistas para cotizar. 24 o 48 horas suele dar mejores precios.'},
      {t:'Publicar',d:'Al publicar, TransMatch revisa la licitación y avisa a los transportistas que calzan. Tu empresa se mantiene anónima hasta que adjudicas.'}
    ],
    'cliente-transporte':[
      {t:'Tus transportes',d:'Aquí están todos tus transportes adjudicados. Haz clic en uno para abrirlo.',s:'[onclick*="toggleCard"]'},
      {t:'Contacto y documentos',d:'Dentro verás el contacto del transportista, podrás solicitarle documentos (seguro, revisión técnica, certificados) y subir tu OC y guía de despacho.'},
      {t:'Factura y valoración',d:'El transportista sube su factura. Cuando el transporte esté entregado y facturado, podrás valorar el servicio. Si algo sale mal, usa Reportar una incidencia.'}
    ],
    'transportista':[
      {t:'Tu resumen',d:'Licitaciones disponibles para cotizar, transportes completados y tu valoración.',s:'#kpi-disponibles',up:'.stat'},
      {t:'Tu nivel',d:'Con 3 transportes completados y buena valoración obtienes la insignia Verificado, que los clientes ven en tus cotizaciones.',s:'#nivel-card'},
      {t:'Licitaciones',d:'Aquí están las licitaciones abiertas. Cotizas sin que el cliente sepa quién eres.',s:NAV('transportista-licitaciones')},
      {t:'Transportes',d:'Cuando te adjudican, el servicio se gestiona aquí: datos del cliente, equipo, documentos y confirmación de entrega.',s:NAV('transportista-transporte')},
      {t:'Facturación',d:'Tus órdenes de venta y las facturas mensuales de comisión de TransMatch.',s:NAV('transportista-cobros')}
    ],
    'transportista-licitaciones':[
      {t:'Filtra las licitaciones',d:'Disponibles, con cotización enviada, adjudicadas y más.',s:'[onclick*="setTabChip"]'},
      {t:'Abre una licitación',d:'Revisa el equipo o carga, la ruta, las fechas y el plazo de cierre. Si tienes dudas, usa Preguntas y respuestas.',s:'.licit-hdr,.licit-card'},
      {t:'Cotiza',d:'Pulsa Cotizar y completa tu oferta: tarifa neta, qué incluye, seguros y tiempos. Puedes enviar hasta 2 cotizaciones por licitación y editarlas mientras esté abierta.'}
    ],
    'transportista-transporte':[
      {t:'Tus transportes',d:'Cada transporte adjudicado aparece aquí. Haz clic para abrirlo.',s:'[onclick*="toggleCard"]'},
      {t:'Equipo y documentos',d:'Asigna el equipo (propio o tercerizado) y el conductor, y sube los documentos que pide el cliente. Si te falta alguno, puedes completarlo después.'},
      {t:'Confirma la entrega',d:'Cuando la carga llegue, indica la fecha real de entrega y sube tu factura del flete. Con eso el transporte queda completo.'}
    ],
    'transportista-perfil':[
      {t:'Mis equipos',d:'Registra cada camión o rampla con sus documentos. Te avisamos antes de que venzan.',s:'[onclick*="showTab(\'equipos\'"]'},
      {t:'Conductores',d:'Registra a tus conductores con su cédula y licencia para asignarlos rápido a cada transporte.',s:'[onclick*="showTab(\'conductores\'"]'},
      {t:'Operaciones',d:'Marca las zonas donde operas y tus tipos de equipo: así te avisamos solo de las licitaciones que te calzan.',s:'[onclick*="showTab(\'zonas\'"]'},
      {t:'Avisos',d:'En la campana revisas tus notificaciones y activas los avisos por WhatsApp.',s:'[onclick*="toggleNotifs"]'}
    ]
  };
  var page=(location.pathname.split('/').pop()||'').replace(/\.html$/,'');
  var pasos=G[page]; if(!pasos) return;
  var rol=page.indexOf('transportista')===0?'transportista':'cliente';
  var KEY='tm_guia_vista_'+page;
  function ls(k,v){ try{ if(v===undefined) return localStorage.getItem(k); localStorage.setItem(k,v); }catch(e){ return null; } }

  var css=document.createElement('style');
  css.textContent='.tmg-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#FF8808;color:#fff;border:none;border-radius:999px;padding:10px 16px;font:700 14px Barlow,system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.22);cursor:pointer}'
   +'.tmg-btn:hover{filter:brightness(.95)}'
   +'.tmg-dim{position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.55)}'
   +'.tmg-hole{position:fixed;z-index:2147483002;border:2px solid #FF8808;border-radius:10px;box-shadow:0 0 0 9999px rgba(15,23,42,.55);pointer-events:none;transition:all .2s}'
   +'.tmg-card{position:fixed;z-index:2147483003;width:340px;max-width:calc(100vw - 32px);background:#fff;border-radius:12px;padding:16px 18px;font-family:Barlow,system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.28)}'
   +'.tmg-k{font-size:11px;font-weight:700;color:#FF8808;letter-spacing:.06em}.tmg-t{font-size:16px;font-weight:700;color:#1e2d4e;margin:4px 0 6px}.tmg-d{font-size:13px;color:#4B5563;line-height:1.5}'
   +'.tmg-f{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:8px}.tmg-l{background:none;border:none;font:500 12px Barlow,sans-serif;color:#9CA3AF;cursor:pointer;padding:0}'
   +'.tmg-p{background:none;border:none;font:500 13px Barlow,sans-serif;color:#6B7280;cursor:pointer;margin-right:10px}.tmg-n{background:#1e2d4e;color:#fff;border:none;border-radius:8px;padding:7px 14px;font:600 13px Barlow,sans-serif;cursor:pointer}'
   +'@media print{.tmg-btn{display:none}}';
  document.head.appendChild(css);

  var btn=document.createElement('button'); btn.className='tmg-btn'; btn.type='button'; btn.textContent='? ¿Cómo funciona?';
  btn.onclick=function(){ abrir(0); };
  document.body.appendChild(btn);

  var dim,hole,card,i=0;
  function visible(el){ if(!el) return false; var r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&el.offsetParent!==null; }
  function buscar(p){
    if(p.s){ var els=[].slice.call(document.querySelectorAll(p.s)); for(var k=0;k<els.length;k++) if(visible(els[k])) return (p.up&&els[k].closest(p.up))||els[k]; }
    if(p.x){ var c=[].slice.call(document.querySelectorAll('a,button,.tipo-card,[onclick]')); for(var j=0;j<c.length;j++) if(visible(c[j])&&c[j].textContent.indexOf(p.x)>=0) return c[j]; }
    return null;
  }
  function cerrar(){ [dim,hole,card].forEach(function(e){ if(e&&e.parentNode) e.parentNode.removeChild(e); }); dim=hole=card=null; window.removeEventListener('resize',pintar); window.removeEventListener('scroll',pintar,true); ls(KEY,'1'); }
  function pintar(){
    if(!card) return; var p=pasos[i], el=buscar(p);
    if(el){
      var r=el.getBoundingClientRect(), pad=6;
      if(dim){ dim.style.display='none'; } hole.style.display='block';
      hole.style.left=(r.left-pad)+'px'; hole.style.top=(r.top-pad)+'px'; hole.style.width=(r.width+pad*2)+'px'; hole.style.height=(r.height+pad*2)+'px';
      var cw=card.offsetWidth, ch=card.offsetHeight, vw=window.innerWidth, vh=window.innerHeight;
      var top=r.bottom+14; if(top+ch>vh-10) top=Math.max(10,r.top-ch-14);
      var left=Math.min(Math.max(10,r.left), vw-cw-10);
      card.style.left=left+'px'; card.style.top=top+'px'; card.style.transform='none';
    } else {
      hole.style.display='none'; dim.style.display='block';
      card.style.left='50%'; card.style.top='50%'; card.style.transform='translate(-50%,-50%)';
    }
  }
  function mostrar(n){
    i=n; var p=pasos[i], ult=i===pasos.length-1, el=buscar(p);
    if(el){ var r=el.getBoundingClientRect(); if(r.top<70||r.bottom>window.innerHeight-200) el.scrollIntoView({block:'center'}); }
    card.innerHTML='<div class="tmg-k">PASO '+(i+1)+' DE '+pasos.length+'</div><div class="tmg-t">'+p.t+'</div><div class="tmg-d">'+p.d+'</div>'
      +(ult?'<div class="tmg-d" style="margin-top:8px">¿Quieres más detalle? Revisa el <a href="/ayuda.html?rol='+rol+'" style="color:#FF8808;font-weight:600">Centro de ayuda</a>.</div>':'')
      +'<div class="tmg-f"><button class="tmg-l" data-a="x">'+(ult?'':'Saltar guía')+'</button><span>'+(i>0?'<button class="tmg-p" data-a="p">Anterior</button>':'')+'<button class="tmg-n" data-a="n">'+(ult?'Entendido':'Siguiente')+'</button></span></div>';
    card.querySelector('[data-a="n"]').onclick=function(){ ult?cerrar():mostrar(i+1); };
    var pv=card.querySelector('[data-a="p"]'); if(pv) pv.onclick=function(){ mostrar(i-1); };
    card.querySelector('[data-a="x"]').onclick=cerrar;
    setTimeout(pintar,60);
  }
  function abrir(n){
    if(card) cerrar();
    dim=document.createElement('div'); dim.className='tmg-dim'; dim.onclick=cerrar;
    hole=document.createElement('div'); hole.className='tmg-hole';
    card=document.createElement('div'); card.className='tmg-card'; card.setAttribute('role','dialog');
    document.body.appendChild(dim); document.body.appendChild(hole); document.body.appendChild(card);
    window.addEventListener('resize',pintar); window.addEventListener('scroll',pintar,true);
    mostrar(n||0);
  }
  document.addEventListener('keydown',function(e){ if(card&&e.key==='Escape') cerrar(); });
  if(!ls(KEY)) setTimeout(function(){ if(!card) abrir(0); },1500);
  window.tmAbrirGuia=abrir;
})();
