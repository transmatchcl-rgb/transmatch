#!/usr/bin/env python3
# Cambia el titulo y la bajada de la seccion "Donde operamos".
# Correr dentro del repo: python3 patch_sectores.py
import io
f='index.html'
s=io.open(f,encoding='utf-8').read()

def rep(old,new,tag):
    global s
    n=s.count(old)
    if n==0: raise SystemExit('  x no encontre: '+tag+' (ya aplicado o texto distinto)')
    if n>1: raise SystemExit('  x ambiguo ('+str(n)+'): '+tag)
    s=s.replace(old,new)

rep('<h2 style="margin-top:10px">Industrias que <em>movemos</em></h2>',
    '<h2 style="margin-top:10px">Movemos industrias que <em>no se detienen</em></h2>','titulo')

rep('<p class="section-sub">Transporte especializado para operaciones donde detenerse cuesta caro &mdash; desde equipos a faena hasta contenedores a puerto.</p>',
    '<p class="section-sub">Detenerse no es opción. Movemos la carga especializada que mantiene tu operación en marcha.</p>','bajada')

io.open(f,'w',encoding='utf-8').write(s)
print('index.html : OK (titulo y bajada actualizados)')
