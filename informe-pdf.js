/* TransMatch · PDF del informe mensual (compartido por admin-informes y cliente-perfil).
   Uso: TMInformePDF(informe, razonSocial, "septiembre 2026") — requiere jsPDF cargado. */
(function(){
 var _logo=new Image(); _logo.src='/logo-pdf.png';
 function _infCLP(n){ return new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(n||0); }
 function _infCorto(n){ n=Number(n)||0; if(n>=1000000) return '$'+(Math.round(n/100000)/10).toLocaleString('es-CL')+'M'; return _infCLP(n); }
 function _infDec(n){ return n==null?'—':String(n).replace('.',','); }
 window.TMInformePDF=function(inf, razonSocial, nombrePeriodo){
   if(!window.jspdf){ alert('No se pudo generar el PDF. Recarga la página e intenta de nuevo.'); return; }
   var pdf=new window.jspdf.jsPDF('p','mm','a4'); var pw=pdf.internal.pageSize.getWidth(), ph=pdf.internal.pageSize.getHeight();
   var mL=18,mR=18,y=20,cw=pw-mL-mR;
   function nl(s){ y+=s; if(y>ph-20){ pdf.addPage(); y=20; } }
   function sec(t){ nl(6); pdf.setFont('helvetica','bold'); pdf.setFontSize(9); pdf.setTextColor(107,114,128); pdf.text(t.toUpperCase(),mL,y); pdf.setDrawColor(225,228,235); pdf.setLineWidth(0.3); pdf.line(mL,y+1.5,pw-mR,y+1.5); nl(7); }
   try{ pdf.addImage(_logo,'PNG',mL,y-4.6,30,30/5.99); }catch(err){ pdf.setFont('helvetica','bold'); pdf.setTextColor(30,45,78); pdf.setFontSize(15); pdf.text('TransMatch',mL,y); }
   var mesT=String(nombrePeriodo).replace(/^./,function(c){return c.toUpperCase();});
   pdf.setFont('helvetica','bold'); pdf.setTextColor(30,45,78); pdf.setFontSize(15); pdf.text('Informe mensual',pw-mR,y,{align:'right'});
   pdf.setFont('helvetica','normal'); pdf.setFontSize(10); pdf.setTextColor(107,114,128); pdf.text(mesT+' · '+razonSocial,pw-mR,y+6,{align:'right'});
   pdf.setDrawColor(30,45,78); pdf.setLineWidth(0.5); pdf.line(mL,y+10,pw-mR,y+10); y+=20;
   var kp=[[String(inf.publicadas),'Licitaciones publicadas'],[String(inf.adjudicadas),'Transportes adjudicados'],[_infCorto(inf.montoAdjudicado),'Monto adjudicado'],[_infDec(inf.cotizacionesPromedio),'Cotizaciones promedio por licitación'],[String(inf.completados),'Transportes completados'],[_infDec(inf.valoracionPromedio),'Valoración promedio'] ];
   var bw=(cw-8)/3, bh=22;
   kp.forEach(function(k,j){ var cx=mL+(j%3)*(bw+4), cy=y+Math.floor(j/3)*(bh+4);
     pdf.setDrawColor(225,228,235); pdf.setLineWidth(0.3); pdf.roundedRect(cx,cy,bw,bh,2,2);
     pdf.setFont('helvetica','bold'); pdf.setFontSize(16); pdf.setTextColor(30,45,78); pdf.text(k[0],cx+4,cy+9);
     pdf.setFont('helvetica','normal'); pdf.setFontSize(8.5); pdf.setTextColor(107,114,128); pdf.text(pdf.splitTextToSize(k[1],bw-8),cx+4,cy+15); });
   y+=2*(bh+4)+2;
   if(inf.rutas.length){ sec('Rutas más usadas'); pdf.setFontSize(10);
     inf.rutas.forEach(function(r){ pdf.setFont('helvetica','normal'); pdf.setTextColor(31,41,55); pdf.text(r.ruta.replace('→','->'),mL,y); pdf.setFont('helvetica','bold'); pdf.text(String(r.cantidad),pw-mR,y,{align:'right'}); pdf.setDrawColor(238,238,238); pdf.setLineWidth(0.2); pdf.line(mL,y+2.5,pw-mR,y+2.5); nl(7); }); }
   if(inf.detalle.length){ sec('Transportes adjudicados');
     var cx=[mL, mL+26, pw-mR-38, pw-mR];
     pdf.setFont('helvetica','bold'); pdf.setFontSize(8.5); pdf.setTextColor(107,114,128);
     pdf.text('LICITACIÓN',cx[0],y); pdf.text('EQUIPO · RUTA',cx[1],y); pdf.text('COTIZ.',cx[2],y,{align:'right'}); pdf.text('ADJUDICADO',cx[3],y,{align:'right'}); nl(6);
     inf.detalle.forEach(function(d){
       var desc=pdf.splitTextToSize(d.equipo+' · '+d.origen+' -> '+d.destino, cx[2]-cx[1]-14);
       pdf.setFont('helvetica','normal'); pdf.setFontSize(9.5); pdf.setTextColor(31,41,55);
       pdf.text(String(d.codigo),cx[0],y); pdf.text(desc,cx[1],y); pdf.text(String(d.cotizaciones),cx[2],y,{align:'right'}); pdf.text(_infCLP(d.precio),cx[3],y,{align:'right'});
       pdf.setDrawColor(238,238,238); pdf.setLineWidth(0.2); pdf.line(mL,y+2.5+(desc.length-1)*4.5,pw-mR,y+2.5+(desc.length-1)*4.5); nl(7+(desc.length-1)*4.5); });
     nl(2); pdf.setFontSize(8.5); pdf.setTextColor(156,163,175); pdf.text('Montos netos, sin IVA.',mL,y); }
   pdf.setFontSize(8); pdf.setTextColor(156,163,175); pdf.text('Generado por TransMatch · transmatch.cl',mL,ph-10);
   var slug=String(razonSocial||'cliente').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_|_$/g,'');
   pdf.save('Informe_TransMatch_'+slug+'_'+inf.periodo+'.pdf');
 
 };
})();
