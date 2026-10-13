// Muestra en la pestaña "WhatsApp" del admin cuántas conversaciones tienen mensajes sin leer.
(function(){
  if(localStorage.getItem('tm_role')!=='admin' || !localStorage.getItem('tm_token')) return;
  var API=(localStorage.getItem('tm_api')||'https://transmatch.transmatchcl.workers.dev');
  function act(){
    fetch(API+'/api/admin/wa/no-leidos',{ headers:{ 'Authorization':'Bearer '+localStorage.getItem('tm_token') } })
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(j){ if(!j) return; var n=j.noLeidos||0; document.querySelectorAll('.wa-nav-bdg').forEach(function(b){ b.textContent=n; b.style.display=n?'inline-block':'none'; }); })
      .catch(function(){});
  }
  act(); setInterval(function(){ if(!document.hidden) act(); }, 60000);
})();
