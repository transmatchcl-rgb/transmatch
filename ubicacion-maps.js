/* TransMatch · Ubicación en Google Maps (link o Plus Code)
   Campo opcional junto a cada dirección. Uso:
     TMUbic.tipo(v)   -> 'link' | 'plus' | 'bad' | null
     TMUbic.valida(v) -> string limpio o '' si no es válido
     TMUbic.url(v)    -> URL segura para abrir en Maps, o ''
     TMUbic.boton(v)  -> HTML del botón "Abrir en Maps", o ''
     TMUbic.campo(id, valor) -> HTML del input con ayuda y detección
     TMUbic.bind(root) -> activa la detección en vivo de los inputs .tm-ubic dentro de root */
(function(){
  var RE_LINK=/^https:\/\/(www\.)?(google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6}|maps\.app\.goo\.gl|goo\.gl\/maps)(\/|\?|$)/i;
  var RE_PLUS=/^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}(\s+[^<>"']{1,80})?$/i;
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function norm(v){ v=String(v||'').trim(); if(/^http:\/\//i.test(v)) v='https://'+v.slice(7); return v; }
  function tipo(v){ v=norm(v); if(!v) return null; if(v.length<=500 && RE_LINK.test(v)) return 'link'; if(RE_PLUS.test(v)) return 'plus'; return 'bad'; }
  function valida(v){ var t=tipo(v); return (t==='link'||t==='plus')?norm(v):''; }
  function url(v){ var t=tipo(v); v=norm(v); if(t==='link') return v; if(t==='plus') return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(v); return ''; }
  function boton(v){
    var u=url(v); if(!u) return '';
    return '<a href="'+esc(u)+'" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;background:#fff;color:#1e2d4e;border:1px solid #e8eaf0;font-size:12px;font-weight:600;padding:5px 10px;border-radius:7px;text-decoration:none;white-space:nowrap">📍 Abrir en Maps</a>';
  }
  function campo(id, valor){
    return '<div class="form-group tm-ubic-wrap" style="margin-bottom:8px"><label style="font-size:12px">Ubicación en Google Maps <span style="font-weight:400;color:#6B7280">(opcional)</span></label>'+
      '<input type="text" '+(id?'id="'+esc(id)+'" ':'')+'class="tm-ubic" value="'+esc(valor||'')+'" placeholder="Pega un link de Google Maps o un Plus Code" autocomplete="off"/>'+
      '<div class="tm-ubic-res" style="font-size:12px;margin-top:4px"></div></div>';
  }
  function actualizar(inp){
    var res=inp.parentElement&&inp.parentElement.querySelector('.tm-ubic-res'); if(!res) return;
    var t=tipo(inp.value);
    if(!t){ res.innerHTML=''; return; }
    if(t==='link') res.innerHTML='<span style="color:#14532D;font-weight:600">✓ Link de Google Maps</span>';
    else if(t==='plus') res.innerHTML='<span style="color:#14532D;font-weight:600">✓ Plus Code</span>';
    else res.innerHTML='<span style="color:#991B1B;font-weight:600">No parece un link de Google Maps ni un Plus Code</span>';
  }
  function bind(root){
    (root||document).querySelectorAll('input.tm-ubic').forEach(function(inp){
      if(inp._tmUbic) return; inp._tmUbic=true;
      inp.addEventListener('input',function(){ actualizar(inp); }); actualizar(inp);
    });
  }
  // Si pegan un link o Plus Code en el campo de dirección, se mueve solo al campo de ubicación.
  function vincular(dirEl, ubicEl){
    if(!dirEl||!ubicEl||dirEl._tmVinc) return; dirEl._tmVinc=true;
    function revisar(){
      var t=tipo(dirEl.value); if(t!=='link'&&t!=='plus') return;
      ubicEl.value=norm(dirEl.value); dirEl.value='';
      ubicEl.dispatchEvent(new Event('input'));
      var av=dirEl.parentElement.querySelector('.tm-ubic-aviso');
      if(!av){ av=document.createElement('div'); av.className='tm-ubic-aviso'; av.style.cssText='font-size:12px;color:#92400E;margin-top:4px'; dirEl.parentElement.appendChild(av); }
      av.textContent=(t==='link'?'Movimos el link':'Movimos el Plus Code')+' al campo de ubicación en Google Maps. Si quieres, escribe aquí la dirección.';
      clearTimeout(av._t); av._t=setTimeout(function(){ av.remove(); },8000);
    }
    dirEl.addEventListener('paste',function(){ setTimeout(revisar,0); });
    dirEl.addEventListener('blur',revisar);
  }
  window.TMUbic={ tipo:tipo, valida:valida, url:url, boton:boton, campo:campo, bind:bind, vincular:vincular };
})();
