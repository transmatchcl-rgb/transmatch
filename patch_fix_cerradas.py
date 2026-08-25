#!/usr/bin/env python3
# Fix: un transportista no debe ver licitaciones cerradas/adjudicadas/completadas
# en las que no participo (pestaña "Todas").
# Correr dentro del repo: python3 patch_fix_cerradas.py
import io
f='transportista-licitaciones.html'
s=io.open(f,encoding='utf-8').read()

marker="if(l.estado!=='abierta' && !misCotizaciones.has(l.id)) return false;"
if marker in s:
    raise SystemExit('Ya estaba aplicado. No hago nada.')

old='''if(l.estado==='abierta' && !misCotizaciones.has(l.id) && !licitacionVigente(l)) return false;
return true;'''
new='''if(l.estado==='abierta' && !misCotizaciones.has(l.id) && !licitacionVigente(l)) return false;
// Ocultar cerradas/adjudicadas/completadas en las que el transportista no participo
if(l.estado!=='abierta' && !misCotizaciones.has(l.id)) return false;
return true;'''

n=s.count(old)
if n==0: raise SystemExit('x no encontre el bloque del filtro (archivo distinto?)')
if n>1: raise SystemExit('x el bloque aparece '+str(n)+' veces (ambiguo)')
s=s.replace(old,new)
io.open(f,'w',encoding='utf-8').write(s)
print('transportista-licitaciones.html : OK (filtro corregido)')
