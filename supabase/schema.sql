-- ============================================================================
-- TransMatch — Esquema de base de datos (Supabase / PostgreSQL)
-- Fase 1 del proyecto de migración desde Cloudflare KV.
--
-- Cómo usarlo:
--   1. Entra a tu proyecto en Supabase → SQL Editor → New query.
--   2. Pega TODO este archivo y presiona "Run".
--   3. Se crean todas las tablas vacías. Los datos se cargan en la Fase 2.
--
-- Diseño:
--   - Cada entidad tiene columnas reales para lo que se consulta/exporta,
--     y una columna `datos JSONB` que guarda el objeto completo (respaldo:
--     así ningún campo se pierde aunque no tenga columna propia).
--   - Las relaciones (FK) están al final, como paso separado y opcional,
--     para que la carga de datos no falle si hubiera algún registro huérfano.
-- ============================================================================

-- Limpieza (solo si quieres re-crear desde cero; comentado por seguridad):
-- drop schema public cascade; create schema public;

-- ────────────────────────────────────────────────────────────────────────────
-- EMPRESAS  (hoy: namespace EMPRESAS, clave empresa:<id>)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists empresas (
  id              text primary key,
  tipo            text,                 -- 'cliente' | 'transportista'
  razon_social    text,
  rut             text,
  giro            text,
  direccion       text,
  comuna          text,
  ciudad          text,
  telefono        text,
  web             text,
  descripcion     text,
  plan            text,
  estado          text,
  dueno_email     text,
  max_usuarios    int,
  industrias      jsonb,
  vigencia        jsonb,                -- prueba/contrato: {tipo, inicio, fin, periodicidad, ...}
  facturacion     jsonb,
  contactos       jsonb,
  datos_bancarios jsonb,
  datos           jsonb,                -- respaldo del objeto completo
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- USUARIOS  (hoy: namespace USERS, clave = email)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists usuarios (
  id                 text primary key,
  email              text unique not null,
  password_hash      text,
  nombre             text,
  telefono           text,
  cargo              text,
  role               text,             -- 'cliente' | 'transportista' | 'admin'
  estado             text,             -- 'activo' | 'pendiente' | 'suspendido'
  plan               text,
  empresa_id         text,             -- FK -> empresas.id
  rol                text,             -- 'dueno' | 'gestor' | 'miembro' | 'visor'
  es_subusuario      boolean default false,
  empresa_madre_id   text,
  rating             numeric,
  total_transportes  int default 0,
  zonas              jsonb,
  industrias         jsonb,
  tipos_equipo       jsonb,
  notif_prefs        jsonb,
  datos              jsonb,
  created_at         timestamptz default now()
);
create index if not exists idx_usuarios_empresa on usuarios(empresa_id);
create index if not exists idx_usuarios_role   on usuarios(role);

-- ────────────────────────────────────────────────────────────────────────────
-- EQUIPOS del transportista  (hoy: array user.equipos[])
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists equipos (
  id             text primary key,
  usuario_id     text,                 -- dueño del equipo
  empresa_id     text,
  tipo           text,
  marca          text,
  modelo         text,
  ano            text,
  patente        text,
  capacidad_max  numeric,
  largo_max      numeric,
  ancho_max      numeric,
  alto_max       numeric,
  descripcion    text,
  documentos     jsonb,                -- vencimientos de documentos, etc.
  datos          jsonb,
  created_at     timestamptz default now()
);
create index if not exists idx_equipos_usuario on equipos(usuario_id);

-- ────────────────────────────────────────────────────────────────────────────
-- LICITACIONES  (hoy: namespace LICITACIONES)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists licitaciones (
  id                              text primary key,
  codigo                          text,
  empresa_id                      text,   -- cliente dueño de la licitación
  creado_por_email                text,
  tipo_licitacion                 text,   -- 'maquinaria' | 'carga'
  tipo_equipo                     text,
  tipo_equipo_requerido           text,
  marca                           text,
  modelo                          text,
  cantidad_equipos                text,
  tipo_carga                      text,
  peso                            text,
  peso_unidad                     text,   -- 'ton' | 'kg'
  volumen                         text,
  dimensiones                     text,
  descripcion                     text,
  origen                          text,
  destino                         text,
  direccion_origen                text,
  direccion_destino               text,
  tipo_entrega_destino            text,
  valor_seguro                    text,
  fecha_carga                     date,
  hora_carga                      text,
  fecha_entrega                   date,
  hora_descarga                   text,
  plazo                           text,
  requiere_estandar               boolean default false,
  estandar_detalle                text,
  archivo_id                      text,
  archivo_nombre                  text,
  archivo_visible_transportista   boolean,
  estandar_archivo_id             text,
  estandar_archivo_nombre         text,
  estandar_archivo_visible_transportista boolean,
  estado                          text,   -- pendiente_admin|abierta|cerrada|adjudicada|completada|rechazada|expirada|anulada
  ronda                           int,
  cierre_at                       timestamptz,
  aprobada_at                     timestamptz,
  adjudicada_at                   timestamptz,
  cerrada_at                      timestamptz,
  expirada_at                     timestamptz,
  cerrada_por_admin               boolean,
  cerrada_por_vencimiento         boolean,
  motivo_cierre                   text,
  comentario_admin                text,
  adjudicada_a                    jsonb,
  valoracion                      jsonb,
  comentarios_admin               jsonb,
  estandar_requisitos             jsonb,
  datos                           jsonb,  -- contenedor/IMO/reefer/paradas/etc.
  created_at                      timestamptz default now()
);
create index if not exists idx_licit_empresa on licitaciones(empresa_id);
create index if not exists idx_licit_estado  on licitaciones(estado);
create index if not exists idx_licit_codigo  on licitaciones(codigo);

-- ────────────────────────────────────────────────────────────────────────────
-- COTIZACIONES  (hoy: array licitacion.cotizaciones[])
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists cotizaciones (
  id                    text primary key,
  codigo                text,
  licitacion_id         text,
  transportista_id      text,
  transportista_email   text,
  transportista_empresa text,
  transportista_nombre  text,
  precio                numeric,
  modalidad             text,           -- 'Consolidada' | 'No consolidada'
  tiempo_entrega        text,
  fecha_carga_iso       text,
  fecha_entrega_iso     text,
  descripcion           text,
  score                 numeric,
  contacto_encargado    jsonb,
  formulario            jsonb,
  archivo_id            text,
  archivo_propio_id     text,
  created_at            timestamptz default now(),
  editado_at            timestamptz,
  datos                 jsonb
);
create index if not exists idx_cotiz_licit on cotizaciones(licitacion_id);
create index if not exists idx_cotiz_transp on cotizaciones(transportista_id);

-- ────────────────────────────────────────────────────────────────────────────
-- PREGUNTAS Q&A  (hoy: array licitacion.preguntas[])
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists preguntas (
  id             text primary key,
  licitacion_id  text,
  autor_id       text,
  autor_rol      text,
  texto          text,
  respuesta      text,
  respondida_at  timestamptz,
  created_at     timestamptz default now(),
  datos          jsonb
);
create index if not exists idx_preguntas_licit on preguntas(licitacion_id);

-- ────────────────────────────────────────────────────────────────────────────
-- TRANSPORTES  (hoy: namespace RETORNOS, clave transporte:<id>)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists transportes (
  id                        text primary key,
  codigo                    text,
  licitacion_id             text,
  empresa_id                text,   -- cliente
  transportista_email       text,
  transportista_empresa     text,
  precio                    numeric,
  estado                    text,   -- preparacion|carga_recogida|en_ruta|en_destino|entregado|completado
  estado_documentos         text,
  oc                        jsonb,
  factura                   jsonb,
  pod                       jsonb,
  guia_despacho             jsonb,
  pago_cliente              jsonb,
  contacto_encargado        jsonb,
  valoracion                jsonb,
  cliente_facturacion       jsonb,
  requisitos_estandar       jsonb,
  asignado_email            text,
  historial                 jsonb,
  incidencias_cliente       jsonb,
  incidencias_transportista jsonb,
  documentos_extra          jsonb,
  adjudicado_at             timestamptz,
  entregado_at              timestamptz,
  completado_at             timestamptz,
  datos                     jsonb,
  created_at                timestamptz default now()
);
create index if not exists idx_transp_empresa on transportes(empresa_id);
create index if not exists idx_transp_licit   on transportes(licitacion_id);
create index if not exists idx_transp_email    on transportes(transportista_email);

-- ────────────────────────────────────────────────────────────────────────────
-- ÓRDENES DE VENTA (comisión TransMatch)  (hoy: namespace OVS, clave ov:<id>)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists ordenes_venta (
  id_ov                    text primary key,
  id_transporte            text,
  id_transportista         text,
  id_cliente               text,
  id_licitacion            text,
  transportista_empresa    text,
  cliente_empresa          text,
  estado                   text,   -- CONDICIONAL|CONFIRMADA|FACTURADA|PAGADA|ANULADA
  monto_cotizado           numeric,
  monto_facturado          numeric,
  comision_estimada        numeric,
  comision_final           numeric,
  comision_porcentaje      numeric,
  comision_tope_uf         numeric,
  tope_aplicado            boolean,
  uf_del_dia               numeric,
  id_factura_transportista text,
  fecha_adjudicacion       timestamptz,
  fecha_confirmacion       timestamptz,
  fecha_facturacion        timestamptz,
  fecha_pago_confirmado     timestamptz,
  metodo_pago              text,
  historial                jsonb,
  datos                    jsonb
);
create index if not exists idx_ov_transp on ordenes_venta(id_transportista);
create index if not exists idx_ov_estado on ordenes_venta(estado);

-- ────────────────────────────────────────────────────────────────────────────
-- FACTURAS DE SUSCRIPCIÓN  (TransMatch -> empresa cliente)
-- (hoy: array empresa.facturasSuscripcion[])
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists facturas_suscripcion (
  id            text primary key,
  empresa_id    text,
  numero        text,
  periodo       text,
  monto         numeric,
  fecha_emision date,
  estado        text,   -- 'pendiente' | 'pagada'
  archivo_id    text,
  archivo_nombre text,
  pagada_at     timestamptz,
  created_at    timestamptz default now()
);
create index if not exists idx_facsusc_empresa on facturas_suscripcion(empresa_id);

-- ────────────────────────────────────────────────────────────────────────────
-- FACTURAS CONSOLIDADAS (comisión del transportista)  (hoy: OVS factura:<id>)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists facturas_consolidado (
  id                   text primary key,
  transportista_id     text,
  periodo              text,
  monto                numeric,
  estado               text,
  estado_factura       text,   -- 'pendiente' | 'facturado'
  ovs_ids              jsonb,
  factura_sii_archivo_id text,
  created_at           timestamptz default now(),
  datos                jsonb
);
create index if not exists idx_faccons_transp on facturas_consolidado(transportista_id);

-- ────────────────────────────────────────────────────────────────────────────
-- RETORNOS (viajes de vuelta)  (hoy: namespace RETORNOS, índice "all")
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists retornos (
  id                text primary key,
  transportista_id  text,
  transportista_email text,
  origen            text,
  destino           text,
  fecha             date,
  estado            text,
  datos             jsonb,
  created_at        timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- NOTIFICACIONES  (hoy: SESSIONS notif:<userId>:<id>)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists notificaciones (
  id            text primary key,
  destinatario  text,   -- userId o 'admin'
  tipo          text,
  mensaje       text,
  data          jsonb,
  leida         boolean default false,
  created_at    timestamptz default now()
);
create index if not exists idx_notif_dest on notificaciones(destinatario);

-- ────────────────────────────────────────────────────────────────────────────
-- ACTIVIDAD (feed interno)  (hoy: SESSIONS actividad:index)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists actividad (
  id          bigserial primary key,
  tipo        text,
  mensaje     text,
  data        jsonb,
  created_at  timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- INVITACIONES / LINKS DE ACCESO  (hoy: empresa.invitacionesPendientes[] + SESSIONS acceso:<token>)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists invitaciones (
  token       text primary key,
  tipo        text,   -- 'invitacion' | 'acceso'
  empresa_id  text,
  email       text,
  rol         text,
  cargo       text,
  role        text,   -- para links de acceso: cliente|transportista|cualquiera
  usado       boolean default false,
  expira_at   timestamptz,
  created_at  timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- PROPUESTAS DE RETORNO  (hoy: RETORNOS "propuesta:<id>" + índices)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists propuestas (
  id                text primary key,
  retorno_id        text,
  cliente_id        text,
  cliente_email     text,
  transportista_id  text,
  estado            text,   -- 'pendiente' | 'aceptada' | 'rechazada'
  precio_negociado  numeric,
  datos             jsonb,
  created_at        timestamptz default now()
);
create index if not exists idx_prop_retorno on propuestas(retorno_id);
create index if not exists idx_prop_cliente on propuestas(cliente_id);
create index if not exists idx_prop_transportista on propuestas(transportista_id);
alter table propuestas enable row level security;

-- ────────────────────────────────────────────────────────────────────────────
-- ARCHIVOS  (hoy: namespace ARCHIVOS — PDFs/imágenes en base64)
-- Nota: guardar base64 en la tabla funciona, pero pesa. Más adelante conviene
-- moverlos a Supabase Storage. Por ahora se migran tal cual para no perder nada.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists archivos (
  id                    text primary key,
  nombre                text,
  tipo                  text,
  base64                text,
  subido_por            text,
  oculto_transportista  boolean,
  visibilidad           text,   -- 'bidders' | 'adjudicado'
  licitacion_id         text,
  created_at            timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- SECUENCIAS (contadores de códigos LIC/COT/TRN/OV)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists secuencias (
  nombre  text primary key,   -- 'LIC' | 'COT' | 'TRN' | 'OV'
  valor   bigint default 0
);

-- ============================================================================
-- RELACIONES (opcional — correr DESPUÉS de cargar los datos de la Fase 2).
-- Si algún registro quedara huérfano, se puede ejecutar por partes.
-- ============================================================================
-- alter table usuarios            add constraint fk_usuarios_empresa   foreign key (empresa_id)    references empresas(id) on delete set null;
-- alter table licitaciones        add constraint fk_licit_empresa      foreign key (empresa_id)    references empresas(id) on delete set null;
-- alter table cotizaciones        add constraint fk_cotiz_licit        foreign key (licitacion_id) references licitaciones(id) on delete cascade;
-- alter table preguntas           add constraint fk_preg_licit         foreign key (licitacion_id) references licitaciones(id) on delete cascade;
-- alter table transportes         add constraint fk_transp_licit       foreign key (licitacion_id) references licitaciones(id) on delete set null;
-- alter table facturas_suscripcion add constraint fk_facsusc_empresa   foreign key (empresa_id)    references empresas(id) on delete cascade;
