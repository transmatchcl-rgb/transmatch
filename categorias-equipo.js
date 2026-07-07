// ============================================================================
// TM_CATEGORIAS_EQUIPO — listado único de categorías de equipo de transporte
// ============================================================================
// Se usa en 3 lugares para que siempre queden sincronizados:
//   - registro.html            (transportista marca sus equipos al registrarse)
//   - transportista-perfil.html (transportista edita sus equipos)
//   - cliente-nueva.html        (cliente marca el equipo requerido al licitar)
//
// Para agregar, quitar o renombrar una categoría: editar SOLO este archivo.
// No agregar "Otro" aquí — cada pantalla maneja su propia fila de "Otro" por
// separado, con su propio comportamiento (ver cliente-nueva.html para el caso
// de licitación: al elegir "Otro" la licitación debe llegar a todos los
// transportistas, no filtrarse por texto libre).
// ============================================================================
var TM_CATEGORIAS_EQUIPO = [
  { value: "Cama baja" },
  { value: "Camilla" },
  { value: "Equipo modular" },
  { value: "Palote" },
  { value: "Rampla / plataforma" },
  { value: "Camión pluma", sub: "autocarga" },
  { value: "Cama cuna" },
  { value: "Furgón / Sider", sub: "cerrado" },
  { value: "Tolva", sub: "granel" },
  { value: "Portacontenedor" },
  { value: "Camión plano", sub: "plataforma rígida" }
];
