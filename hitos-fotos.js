// Avance del transporte: hitos (llegada a origen, carga, ruta, destino) con fotos enviadas por WhatsApp.
// tmHitosHtml(t) arma el bloque; las fotos se cargan solas cuando el bloque aparece en la página.
(function(){
  var LBL={ en_origen:'Llegó a origen', carga_recogida:'Carga recogida', en_ruta:'En ruta', en_destino:'Llegó a destino', preparacion:'En preparación', entregado:'Entregado' };
  function api(){ return (typeof API!=='undefined'&&API)||localStorage.getItem('tm_api')||'https://transmatch.transmatchcl.workers.dev'; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function fh(iso){ try{ return new Date(iso).toLocaleString('es-CL',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }catch(e){ return iso||''; } }
  window.tmHitosHtml=function(t){
    var items=[];
    (t.hitos||[]).forEach(function(x){ items.push({ fecha:x.fecha, titulo:LBL[x.estado]||x.estado, sub:(x.via==='whatsapp'?'por WhatsApp · ':'')+(x.actor||''), fotoId:x.fotoId }); });
    (t.fotos||[]).forEach(function(x){ items.push({ fecha:x.fecha, titulo:'Foto', sub:'por WhatsApp · '+(x.actor||''), fotoId:x.fotoId }); });
    if(!items.length) return '';
    items.sort(function(a,b){ return String(a.fecha).localeCompare(String(b.fecha)); });
    var h='<div style="background:#fff;border:1px solid #e8eaf0;border-radius:12px;padding:14px 16px;margin:0 0 16px">';
    h+='<div style="font-size:12px;font-weight:700;color:#1e2d4e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Avance del transporte</div>';
    items.forEach(function(it){
      h+='<div style="display:flex;gap:10px;margin-bottom:12px"><div style="width:10px;height:10px;border-radius:50%;background:#FF8808;margin-top:4px;flex:none"></div><div style="min-width:0">';
      h+='<div style="font-size:13px;font-weight:700;color:#1e2d4e">'+esc(it.titulo)+'</div><div style="font-size:11px;color:#6B7280">'+esc(fh(it.fecha))+(it.sub?' · '+esc(it.sub):'')+'</div>';
      if(it.fotoId) h+='<img data-tm-foto="'+esc(it.fotoId)+'" alt="Foto" onclick="tmHitoVerFoto(this)" style="display:block;width:120px;height:90px;object-fit:cover;border-radius:8px;border:1px solid #e8eaf0;margin-top:6px;cursor:zoom-in;background:#F1F5F9"/>';
      h+='</div></div>';
    });
    return h+'</div>';
  };
  window.tmHitoVerFoto=function(img){
    if(!img.src) return;
    var m=document.createElement('div'); m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
    m.innerHTML='<img src="'+img.src+'" style="max-width:100%;max-height:100%;border-radius:8px"/>'; m.onclick=function(){ m.remove(); }; document.body.appendChild(m);
  };
  var cache={};
  async function cargar(img){
    var id=img.getAttribute('data-tm-foto'); img.setAttribute('data-tm-cargando','1');
    try{
      if(!cache[id]){ cache[id]=fetch(api()+'/api/archivos/'+encodeURIComponent(id),{headers:{'Authorization':'Bearer '+localStorage.getItem('tm_token')}}).then(function(r){ return r.ok?r.json():null; }); }
      var d=await cache[id]; if(d&&d.base64) img.src='data:'+(d.tipo||d.mimeType||'image/jpeg')+';base64,'+d.base64;
    }catch(e){}
  }
  function revisar(){ document.querySelectorAll('img[data-tm-foto]:not([data-tm-cargando])').forEach(cargar); }
  function init(){ revisar(); new MutationObserver(revisar).observe(document.body,{ childList:true, subtree:true }); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
