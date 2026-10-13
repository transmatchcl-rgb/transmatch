// Switch "Por WhatsApp" en el panel de notificaciones (campana → Configuración) de las páginas del transportista.
// Se inserta solo si la página no lo trae (transportista-perfil.html ya tiene el suyo).
(function(){
  function api(){ return (typeof API!=='undefined'&&API)||localStorage.getItem('tm_api')||'https://transmatch.transmatchcl.workers.dev'; }
  function tok(){ return localStorage.getItem('tm_token')||''; }
  function telWa(t){ var s=String(t||'').replace(/[^0-9]/g,''); if(!s) return null; if(s.indexOf('56')!==0){ if(s.length===9&&s[0]==='9') s='56'+s; else if(s.length===8) s='569'+s; } return /^569\d{8}$/.test(s)?s:null; }
  function aviso(m,e){ if(typeof toast==='function') toast(m,e?'err':undefined); }
  var chk, sub, row, cargado=false;
  function pintar(activo, tel){
    var t=telWa(tel);
    if(!t){ chk.checked=false; chk.disabled=true; row.style.cursor='default'; sub.style.color='#92400E'; sub.innerHTML='Para recibir avisos por WhatsApp agrega tu celular (+56 9) en <a href="/transportista-perfil.html" style="color:#92400E;font-weight:700">Mi perfil</a>.'; return; }
    chk.disabled=false; row.style.cursor='pointer'; chk.checked=!!activo; sub.style.color='#6B7280';
    var b='+56 9 '+t.slice(3,7)+' '+t.slice(7);
    sub.innerHTML=activo?'Te llegarán las nuevas licitaciones al <b>'+b+'</b> y podrás cotizar directo desde WhatsApp.':'Actívalo para recibir las nuevas licitaciones al <b>'+b+'</b> y cotizar directo desde WhatsApp.';
    sub.dataset.tel=t;
  }
  async function cargar(){
    if(cargado) return; cargado=true;
    try{ var r=await fetch(api()+'/api/auth/me',{headers:{'Authorization':'Bearer '+tok()}}); var d=await r.json(); if(r.ok&&d.user) pintar(!!d.user.notifWhatsapp, d.user.telefono||d.user.whatsapp||''); else cargado=false; }catch(e){ cargado=false; }
  }
  async function cambiar(){
    var quiere=chk.checked; chk.disabled=true;
    try{
      var r=await fetch(api()+'/api/perfil/notificaciones',{ method:'PUT', headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok()}, body:JSON.stringify({ notifWhatsapp:quiere }) });
      var d=await r.json().catch(function(){ return {}; });
      if(!r.ok) throw new Error(d.error||'No se pudo guardar');
      pintar(!!d.notifWhatsapp, d.telefonoWa||sub.dataset.tel||'');
      aviso(quiere?'Avisos por WhatsApp activados':'Avisos por WhatsApp desactivados');
    }catch(e){ chk.checked=!quiere; chk.disabled=false; aviso(e.message||'No se pudo guardar',true); }
  }
  function init(){
    if(document.getElementById('notif-wa-chk')) return;
    var ec=document.getElementById('notif-email-chk'), cfg=document.getElementById('notif-config');
    if(!ec||!cfg) return;
    var lbl=ec.closest('label'); if(!lbl) return;
    row=document.createElement('label'); row.id='notif-wa-row';
    row.style.cssText='display:flex;align-items:center;justify-content:space-between;cursor:pointer';
    row.innerHTML='<span style="font-size:13px;color:#374151">Por WhatsApp <span style="font-size:10px;font-weight:700;color:#FF8808;background:#FFF4E6;border-radius:999px;padding:1px 7px;margin-left:4px">NUEVO</span></span><input type="checkbox" id="notif-wa-chk" style="width:16px;height:16px;accent-color:#1e2d4e;cursor:pointer"/>';
    sub=document.createElement('div'); sub.id='notif-wa-sub'; sub.style.cssText='font-size:11px;color:#6B7280;line-height:1.4;margin-top:-4px';
    lbl.parentNode.insertBefore(sub, lbl.nextSibling); lbl.parentNode.insertBefore(row, sub);
    chk=row.querySelector('input'); chk.addEventListener('change', cambiar);
    var mostrar=function(){ if(cfg.style.display!=='none'){ cargado=false; cargar(); } };
    new MutationObserver(mostrar).observe(cfg,{ attributes:true, attributeFilter:['style'] });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
