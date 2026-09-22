const RF_USER = "SCANER";
const RF_PASS = "1234";
const RF_USUARIOS = {
  SCANER: {
    password: RF_PASS,
    vistas: ["consulta", "asignacion", "validacion", "trabajo", "dashboard", "topPicking", "reportes"],
    inicial: "consulta"
  },
  CDOSLO: {
    password: "291997",
    vistas: ["topPicking", "reportes"],
    inicial: "topPicking"
  }
};
const CAPACIDAD_DINAMICA_UND = 999999;
const TRABAJO_API_URL = "https://script.google.com/macros/s/AKfycbyWQhNnijyYZY3rT5q-5tKdRe3FrgcgpxXvWzPDHCrzzY_d-RQJ4A4GdaB89XHORuvK/exec";
const TRABAJO_API_STORAGE_KEY = "rf_trabajo_api_url";
const TRABAJO_POLL_MS = 5000;

let scannerStream = null;
let scannerDetector = null;
let scannerActivo = false;
let lpnActualRows = [];
let productosActuales = [];
let codigoSeleccionado = "";
let timerSugerencias = null;
let vistaRf = "consulta";
let usuarioActivo = null;
let cacheValidacionPlus = null;
let reporteActivo = "picking";
let turnoReportePicking = "TODOS";
let turnoReporteDespacho = "TODOS";
let proveedoresReporteSeleccionados = null;
let estadoAsignacionOperativa = JSON.parse(localStorage.getItem("rf_asignacion_operativa_estado") || "{}");
let filtroTrabajoAsignacion = "";
let timerFiltroTrabajoAsignacion = null;
let timerSincronizacionTrabajo = null;
let sincronizandoTrabajo = false;
let guardandoTrabajo = new Set();
let operadorTrabajo = localStorage.getItem("rf_trabajo_operador") || "";
let estadoTrabajoRemoto = {};
let firmaEstadoTrabajoRemoto = "";
let tareasTrabajoRegistradas = false;
let registrandoTareasTrabajo = false;
let cacheUsuariosReportePorDni = { firma: "", mapa: new Map() };
let fechaPedidoKpiAsignacion = "";

function perfilUsuarioActivo() {
  return usuarioActivo?.perfil || RF_USUARIOS.SCANER;
}

function usuarioTieneVista(vista) {
  return perfilUsuarioActivo().vistas.includes(vista);
}

function vistaInicialUsuario() {
  return perfilUsuarioActivo().inicial || perfilUsuarioActivo().vistas[0] || "consulta";
}

function aplicarPermisosUsuario() {
  const vistasBotones = {
    consulta: "tabConsulta",
    asignacion: "tabAsignacion",
    validacion: "tabValidacion",
    trabajo: "tabTrabajo",
    dashboard: "tabDashboard",
    topPicking: "tabTopPicking",
    reportes: "tabReportes"
  };
  Object.entries(vistasBotones).forEach(([vista, id]) => {
    const boton = document.getElementById(id);
    if (boton) boton.hidden = !usuarioTieneVista(vista);
  });
  const menuAsignacion = document.getElementById("menuAsignacion");
  if (menuAsignacion) {
    menuAsignacion.hidden = !["asignacion", "validacion", "trabajo", "dashboard"].some(usuarioTieneVista);
  }
  document.getElementById("appView")?.classList.toggle("limited-nav", perfilUsuarioActivo().vistas.length <= 2);
}

function actualizarTituloModuloRf() {
  const titulos = {
    consulta: "Consulta por LPN",
    asignacion: "Asignacion Operacional",
    validacion: "Validacion Plus",
    trabajo: "Trabajo No Asignado",
    dashboard: "Dashboard de avance",
    topPicking: "Top Picking",
    reportes: "Reportes"
  };
  const titulo = document.getElementById("tituloModuloRf");
  if (titulo) titulo.textContent = titulos[vistaRf] || "Modulo RF";
}

function clavesUsuarioDniReporte(valor) {
  const texto = limpiar(valor);
  if (!texto) return [];
  const exacta = normalizar(texto);
  const sinDecimalCero = texto.replace(/[,.]0+$/, "");
  const digitos = sinDecimalCero.replace(/\D/g, "");
  return Array.from(new Set([exacta, digitos].filter(Boolean)));
}

function mapaUsuariosReportePorDni() {
  const data = Array.isArray(dataUsuariosReporte) ? dataUsuariosReporte : [];
  const firma = `${data.length}|${data[0] ? Object.keys(data[0]).join(",") : ""}|${limpiar(campo(data[0] || {}, ["DNI"]))}|${limpiar(campo(data[data.length - 1] || {}, ["DNI"]))}`;
  if (cacheUsuariosReportePorDni.firma === firma) return cacheUsuariosReportePorDni.mapa;
  const mapa = new Map();
  data.forEach(row => {
    const claves = clavesUsuarioDniReporte(campo(row, ["DNI", "Documento", "DOCUMENTO", "Codigo", "CODIGO"]));
    const nombre = limpiar(campo(row, ["Nombre", "NOMBRE", "Nombres", "NOMBRES"]));
    if (nombre) claves.forEach(clave => mapa.set(clave, nombre));
  });
  cacheUsuariosReportePorDni = { firma, mapa };
  return mapa;
}

function nombreUsuarioReporte(usuario) {
  const codigo = limpiar(usuario);
  if (!codigo) return "";
  const mapa = mapaUsuariosReportePorDni();
  for (const clave of clavesUsuarioDniReporte(codigo)) {
    const nombre = mapa.get(clave);
    if (nombre) return nombre;
  }
  return codigo;
}

function urlApiTrabajo() {
  const guardada = String(localStorage.getItem(TRABAJO_API_STORAGE_KEY) || "").trim();
  return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/i.test(guardada)
    ? guardada
    : TRABAJO_API_URL;
}

function apiTrabajoDisponible() {
  return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/i.test(urlApiTrabajo());
}

function firmaEstadoTrabajo(estados) {
  return Object.keys(estados || {}).sort().map(key => {
    const row = estados[key] || {};
    return [key, row.estado, row.operador, row.actualizado].map(limpiar).join("|");
  }).join("~");
}

async function leerAvanceTrabajoHoja() {
  const filas = await cargarHojaDesde(TRABAJO_SHEET_ID, "AVANCE_TRABAJO");
  const estados = {};
  filas.forEach(row => {
    const clave = limpiar(campo(row, ["CLAVE"]));
    if (!clave) return;
    estados[clave] = {
      estado: normalizar(campo(row, ["ESTADO"]) || "PENDIENTE"),
      operador: limpiar(campo(row, ["OPERADOR"])),
      actualizado: limpiar(campo(row, ["ACTUALIZADO"])),
      origen: limpiar(campo(row, ["ORIGEN"])),
      codigo: limpiar(campo(row, ["CODIGO"])),
      ubicacion: limpiar(campo(row, ["UBICACION"])),
      lpn: limpiar(campo(row, ["LPN"])),
      bultos: num(campo(row, ["BULTOS"]))
    };
  });
  return estados;
}

async function leerEstadoTrabajoRemoto() {
  if (!apiTrabajoDisponible() || sincronizandoTrabajo) return;
  sincronizandoTrabajo = true;
  try {
    let remotos = {};
    try {
      const url = new URL(urlApiTrabajo());
      url.searchParams.set("action", "ESTADO");
      url.searchParams.set("_", Date.now());
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.mensaje || "No se pudo leer el avance remoto.");
      remotos = data.estados || {};
    } catch (apiError) {
      console.warn("API Trabajo no disponible:", apiError.message || apiError);
    }
    if (!Object.keys(remotos).length) {
      try {
        remotos = await leerAvanceTrabajoHoja();
      } catch (hojaError) {
        console.warn("No se pudo leer AVANCE_TRABAJO directamente:", hojaError.message || hojaError);
      }
    }
    const nuevaFirma = firmaEstadoTrabajo(remotos);
    const estadoCambio = nuevaFirma !== firmaEstadoTrabajoRemoto;
    estadoTrabajoRemoto = remotos;
    firmaEstadoTrabajoRemoto = nuevaFirma;
    const tareas = datosOperativosListos ? procesarAsignacionOperacionalRf() : { reserva: [], otras: [] };
    [...tareas.reserva, ...tareas.otras].forEach(row => {
      const key = claveAsignacionOperativa(row);
      estadoAsignacionOperativa[key] = normalizar(remotos[key]?.estado) === "COMPLETO" ? "completo" : "pendiente";
    });
    if (estadoCambio) {
      localStorage.setItem("rf_asignacion_operativa_estado", JSON.stringify(estadoAsignacionOperativa));
      if (vistaRf === "trabajo" && datosOperativosListos) renderTrabajoAsignacionMovil();
      else if (vistaRf === "dashboard") renderDashboardTrabajo();
    }
  } catch (error) {
    console.warn("No se pudo sincronizar Trabajo:", error.message || error);
  } finally {
    sincronizandoTrabajo = false;
  }
}

function iniciarSincronizacionTrabajo() {
  if (!apiTrabajoDisponible() || timerSincronizacionTrabajo) return;
  leerEstadoTrabajoRemoto();
  timerSincronizacionTrabajo = setInterval(() => {
    if (vistaRf === "trabajo" || vistaRf === "dashboard") leerEstadoTrabajoRemoto();
  }, TRABAJO_POLL_MS);
}

function detenerSincronizacionTrabajo() {
  if (!timerSincronizacionTrabajo) return;
  clearInterval(timerSincronizacionTrabajo);
  timerSincronizacionTrabajo = null;
}

async function registrarTareasTrabajoRemoto() {
  if (!apiTrabajoDisponible() || tareasTrabajoRegistradas || registrandoTareasTrabajo || !datosOperativosListos) return;
  registrandoTareasTrabajo = true;
  const data = procesarAsignacionOperacionalRf();
  const tareas = [...data.reserva, ...data.otras].map(row => ({
    clave: claveAsignacionOperativa(row),
    origen: row.origen,
    codigo: row.codigo,
    ubicacion: row.ubicacion,
    lpn: row.lpn,
    bultos: row.asignar
  }));
  try {
    const response = await fetch(urlApiTrabajo(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "REGISTRAR_TAREAS", tareas })
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.mensaje || "No se pudieron registrar las tareas.");
    tareasTrabajoRegistradas = true;
    leerEstadoTrabajoRemoto();
  } catch (error) {
    console.warn("No se pudieron registrar las tareas remotas:", error.message || error);
  } finally {
    registrandoTareasTrabajo = false;
  }
}

function limpiarSeleccionConsulta() {
  lpnActualRows = [];
  productosActuales = [];
  codigoSeleccionado = "";
}

function estado(texto) {
  const el = document.getElementById("estadoCarga");
  if (el) el.textContent = texto;
}

function htmlSeguro(valor) {
  return limpiar(valor).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function corto(valor, max = 18) {
  const texto = limpiar(valor);
  return texto.length > max ? `${texto.slice(0, max)}...` : texto;
}

function pct(valor, total) {
  return total > 0 ? (valor / total) * 100 : 0;
}

function pctCumplimiento(valor, total) {
  return Math.min(100, pct(valor, total));
}

function fechaValor(valor) {
  const texto = limpiar(valor);
  if (!texto) return null;
  const serial = Number(texto);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    return new Date(Math.round((serial - 25569) * 86400 * 1000));
  }
  const iso = texto.replace(" ", "T");
  const fecha = new Date(iso);
  if (!Number.isNaN(fecha.getTime())) return fecha;
  const limpio = texto
    .replace(/\ba\.\s*m\.?\b/gi, "AM")
    .replace(/\bp\.\s*m\.?\b/gi, "PM")
    .replace(/\bam\b/gi, "AM")
    .replace(/\bpm\b/gi, "PM");
  let partes = limpio.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  let anio;
  let mes;
  let dia;
  let horaTexto;
  let minutoTexto;
  let segundoTexto;
  let ampmTexto;
  if (partes) {
    const primero = Number(partes[1]);
    const segundo = Number(partes[2]);
    anio = Number(partes[3]);
    if (anio < 100) anio += 2000;
    if (segundo > 12 && primero <= 12) {
      mes = primero - 1;
      dia = segundo;
    } else {
      dia = primero;
      mes = segundo - 1;
    }
    horaTexto = partes[4];
    minutoTexto = partes[5];
    segundoTexto = partes[6];
    ampmTexto = partes[7];
  } else {
    partes = limpio.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (!partes) return null;
    anio = Number(partes[1]);
    mes = Number(partes[2]) - 1;
    dia = Number(partes[3]);
    horaTexto = partes[4];
    minutoTexto = partes[5];
    segundoTexto = partes[6];
    ampmTexto = partes[7];
  }
  let hora = Number(horaTexto || 0);
  const ampm = normalizar(ampmTexto);
  if (ampm === "PM" && hora < 12) hora += 12;
  if (ampm === "AM" && hora === 12) hora = 0;
  return new Date(anio, mes, dia, hora, Number(minutoTexto || 0), Number(segundoTexto || 0));
}

function horaFecha(fecha) {
  return fecha ? fecha.getHours() : null;
}

function horaValor(valor) {
  const texto = limpiar(valor);
  if (!texto) return null;
  const numeroHora = num(texto);
  if (/^[\d.,]+$/.test(texto) && numeroHora > 0 && numeroHora < 1) {
    return Math.floor(numeroHora * 24);
  }
  const fecha = fechaValor(texto);
  if (fecha) return horaFecha(fecha);
  const limpio = texto
    .replace(/\ba\.\s*m\.?\b/gi, "AM")
    .replace(/\bp\.\s*m\.?\b/gi, "PM")
    .replace(/\bam\b/gi, "AM")
    .replace(/\bpm\b/gi, "PM");
  const partes = limpio.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!partes) return null;
  let hora = Number(partes[1]);
  const ampm = normalizar(partes[3]);
  if (!Number.isFinite(hora)) return null;
  if (ampm === "PM" && hora < 12) hora += 12;
  if (ampm === "AM" && hora === 12) hora = 0;
  return hora >= 0 && hora <= 23 ? hora : null;
}

function turnoPorHora(hora) {
  if (hora === null || hora === undefined) return "SIN TURNO";
  if (hora >= 7 && hora < 16) return "DIA";
  if (hora >= 16 && hora < 21) return "TARDE";
  return "NOCHE";
}

function descripcionNoCuentaReporte(descripcion) {
  const texto = normalizar(descripcion).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const frescos = [
    "FRUTA", "FRUTAS", "PLATANO", "BANANO", "BANANA", "PERA", "PERAS", "MANZANA", "MANZANAS",
    "NARANJA", "NARANJAS", "MANDARINA", "MANDARINAS", "LIMON", "LIMONES", "FRESA", "FRESAS",
    "UVA", "UVAS", "MANGO", "MANGOS", "PINA", "PINIA", "PALTA", "PALTAS", "SANDIA",
    "MELON", "PAPAYA", "DURAZNO", "GRANADILLA", "MARACUYA", "KIWI", "CIRUELA", "CHIRIMOYA",
    "VERDURA", "VERDURAS", "HORTALIZA", "HORTALIZAS", "ZANAHORIA", "ZANAHORIAS", "TOMATE",
    "TOMATES", "CEBOLLA", "CEBOLLAS", "PAPA", "PAPAS", "CAMOTE", "CAMOTES", "YUCA",
    "LECHUGA", "LECHUGAS", "BROCOLI", "PEPINO", "PEPINOS", "APIO", "BETERRAGA", "ESPINACA",
    "ROCOTO", "AJI", "AJIES", "CHOCLO", "CHOCLOS", "PIMIENTO", "PIMIENTOS"
  ].map(normalizar);
  if (texto === "JABA" || texto === "JABAS" || texto.startsWith("JABA ") || texto.startsWith("JABAS ")) return true;
  return frescos.some(item => texto === item || texto.startsWith(`${item} `));
}

function reportePickingValido(row) {
  return Number.isFinite(row.bultos) && row.bultos > 0;
}

function modeloPickingReporte() {
  return (dataPickingReporte || []).map((r, index) => {
    const fecha = fechaValor(campo(r, ["FECHA PICK", "FECHA_PICK", "Fecha Pick", "FECHA"]));
    const hora = horaFecha(fecha);
    return {
      index,
      tipo: limpiar(campo(r, ["TIPO ASGIN", "TIPO ASIGN", "TIPO_ASGIN"])) || "SIN TIPO",
      usuario: limpiar(campo(r, ["USUARIO PICKING", "USUARIO", "OPERADOR"])) || "SIN USUARIO",
      lpn: limpiar(campo(r, ["NRO LPN", "LPN"])),
      codigo: limpiar(campo(r, ["CODIGO", "PRODUCTO"])),
      descripcion: limpiar(campo(r, ["DESCRIPCION", "Descripcion"])),
      bultos: num(campo(r, ["BULTOS", "Bultos"])),
      hora,
      turno: turnoPorHora(hora)
    };
  }).filter(reportePickingValido);
}

function modeloRecepcionReporte() {
  return (dataRecepcionReporte || []).map((r, index) => {
    const asn = limpiar(campo(r, ["NRO ASN", "ASN", "Nro ASN"]));
    const codigoProveedorBase = limpiar(campo(r, ["CODIGO PROVEE", "CODIGO PROVEEDOR", "COD PROVEEDOR"]));
    const codigoProveedor = codigoProveedorBase || "917";
    const nombreBase = limpiar(campo(r, ["NOM PROVEEDOR", "NOMBRE PROVEEDOR", "Proveedor"]));
    const proveedor = nombreBase || (codigoProveedor === "917" ? "PUNTA NEGRA" : "SIN PROVEEDOR");
    const fecha = fechaValor(campo(r, ["Fe Recepcion", "FE RECEPCION", "FECHA RECEPCION", "FECHA"]));
    const hora = horaFecha(fecha);
    return {
      index,
      codigoProveedor,
      proveedor,
      proveedorKey: `${codigoProveedor} | ${proveedor}`,
      oc: limpiar(campo(r, ["NRO OC", "Nro OC", "OC", "ORDEN COMPRA", "Orden Compra"])),
      asn,
      lpn: limpiar(campo(r, ["LPN", "NRO LPN", "PALLET", "NroPallet"])),
      codigo: limpiar(campo(r, ["CODIGO", "PRODUCTO"])),
      codAlterno: limpiar(campo(r, ["COD ALTER", "COD ALTERN", "COD_ALTER"])),
      descripcion: limpiar(campo(r, ["DESCRIPCION", "Descripcion"])),
      programado: num(campo(r, ["BULTOS PROGRAMADOS", "BULTOS PROG", "PROGRAMADO"])),
      recibido: num(campo(r, ["BULTOS RECIBIDOS", "BULTOS REC", "RECIBIDO"])),
      unidadesProgramadas: num(campo(r, ["UND PROGRAMADAS", "UNIDADES PROGRAMADAS", "UND PROG"])),
      unidadesRecibidas: num(campo(r, ["UND RECIBIDAS", "UNIDADES RECIBIDAS", "UND REC"])),
      usuario: limpiar(campo(r, ["USU RECEP", "USUARIO RECEPCION", "USUARIO"])) || "SIN USUARIO",
      fecha,
      hora,
      turno: turnoPorHora(hora),
      raw: r
    };
  }).filter(r => !normalizar(r.asn).startsWith("ILE"));
}

function agruparSuma(data, fn, valueFn) {
  const mapa = new Map();
  data.forEach(row => {
    const key = fn(row) || "SIN DATO";
    if (!mapa.has(key)) mapa.set(key, { label: key, valor: 0, registros: 0 });
    const item = mapa.get(key);
    item.valor += valueFn(row);
    item.registros += 1;
  });
  return Array.from(mapa.values()).sort((a, b) => b.valor - a.valor || b.registros - a.registros);
}

function reporteLineal(titulo, data, total, color = "#315c7a") {
  const max = Math.max(...data.map(x => x.valor), 1);
  const points = data.map((x, i) => {
    const xPos = data.length === 1 ? 500 : 28 + (i / (data.length - 1)) * 944;
    const yPos = 190 - (x.valor / max) * 160;
    return { ...x, x: xPos, y: yPos };
  });
  const path = points.reduce((d, p, i) => {
    if (i === 0) return `M ${p.x} ${p.y}`;
    const prev = points[i - 1];
    const mid = (prev.x + p.x) / 2;
    return `${d} C ${mid} ${prev.y}, ${mid} ${p.y}, ${p.x} ${p.y}`;
  }, "");
  return `
    <section class="rf-report-panel rf-chart">
      <header><h3>${htmlSeguro(titulo)}</h3><strong>${fmt(total)}</strong></header>
      <svg viewBox="0 0 1000 210" preserveAspectRatio="none">
        <line x1="25" y1="190" x2="975" y2="190"></line>
        <line x1="25" y1="136" x2="975" y2="136"></line>
        <line x1="25" y1="82" x2="975" y2="82"></line>
        <line x1="25" y1="28" x2="975" y2="28"></line>
        <path d="${path}" style="stroke:${color}"></path>
        ${points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="7" style="fill:${color}"></circle>`).join("")}
      </svg>
      <div class="rf-axis">${points.map(p => `<span><b>${fmt(p.valor)}</b><small>${htmlSeguro(p.label)}</small></span>`).join("")}</div>
    </section>
  `;
}

function reporteBarras(titulo, data, total) {
  const max = Math.max(...data.map(x => x.valor), 1);
  return `
    <section class="rf-report-panel rf-bars">
      <header><h3>${htmlSeguro(titulo)}</h3><strong>${fmt(total)}</strong></header>
      <div>
        ${data.map(x => `<article><span>${htmlSeguro(x.label)}</span><div><i style="width:${Math.min(100, pct(x.valor, max))}%"></i></div><b>${fmt(x.valor)}</b></article>`).join("")}
      </div>
    </section>
  `;
}

function reporteRankingUsuarios(data, total) {
  const top = agruparSuma(data, r => r.usuario, r => r.bultos).slice(0, 10);
  return `
    <section class="rf-report-panel rf-ranking">
      <header><h3>TOP 10 USUARIOS</h3><strong>${fmt(top.length)}</strong></header>
      ${top.map((x, i) => `
        <article>
          <em>${i + 1}</em>
          <span><b>${htmlSeguro(corto(x.label, 20))}</b><small>${fmt(x.registros)} registros</small></span>
          <strong>${fmt(x.valor)}</strong>
          <i style="width:${Math.min(100, pct(x.valor, top[0]?.valor || 1))}%"></i>
        </article>
      `).join("") || `<div class="empty-mini">Sin usuarios para mostrar.</div>`}
    </section>
  `;
}

function horasPickingReporte(data) {
  return agruparSuma(data, r => r.hora === null || r.hora === undefined ? "S/H" : `${String(r.hora).padStart(2, "0")}:00`, r => r.bultos)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), "es", { numeric: true }));
}

function usuariosPickingReporte(data) {
  const mapa = new Map();
  data.forEach(row => {
    const usuario = row.usuario || "SIN USUARIO";
    if (!mapa.has(usuario)) {
      mapa.set(usuario, {
        usuario,
        bultos: 0,
        registros: 0,
        lpns: new Set(),
        turnos: new Map()
      });
    }
    const item = mapa.get(usuario);
    item.bultos += row.bultos;
    item.registros += 1;
    if (row.lpn) item.lpns.add(row.lpn);
    item.turnos.set(row.turno, (item.turnos.get(row.turno) || 0) + row.bultos);
  });
  return Array.from(mapa.values()).map(item => ({
    ...item,
    nombre: nombreUsuarioReporte(item.usuario),
    lpnsTotal: item.lpns.size,
    turnosDetalle: Array.from(item.turnos.entries()).sort((a, b) => {
      const orden = { DIA: 1, TARDE: 2, NOCHE: 3, "SIN TURNO": 4 };
      return (orden[a[0]] || 99) - (orden[b[0]] || 99);
    })
  })).sort((a, b) => b.bultos - a.bultos || b.registros - a.registros);
}

function tendenciaPickingMovil(data, total, titulo = "Tendencia picking", etiquetaVacia = "Sin datos horarios para este turno.") {
  if (!data.length) return `<section class="rf-mobile-card"><div class="empty-mini">${htmlSeguro(etiquetaVacia)}</div></section>`;
  const max = Math.max(...data.map(x => x.valor), 1);
  const pico = data.slice().sort((a, b) => b.valor - a.valor)[0];
  const promedio = data.length ? total / data.length : 0;
  return `
    <section class="rf-mobile-card rf-hour-report">
      <div class="rf-mobile-section-title">
        <h3>${htmlSeguro(titulo)}</h3>
        <strong>${fmt(total)}</strong>
      </div>
      <div class="rf-hour-summary">
        <article>
          <span>Pico</span>
          <strong>${htmlSeguro(pico.label)}</strong>
          <b>${fmt(pico.valor)}</b>
        </article>
        <article>
          <span>Promedio</span>
          <strong>${fmt(promedio)}</strong>
          <b>${fmt(data.length)} horas</b>
        </article>
      </div>
      <div class="rf-hour-bars">
        ${data.map(item => `
          <article class="${item === pico ? "peak" : ""}">
            <span>${htmlSeguro(item.label)}</span>
            <div><i style="width:${Math.max(4, pct(item.valor, max))}%"></i></div>
            <strong>${fmt(item.valor)}</strong>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function iconoRf(tipo) {
  const base = {
    total: `<path d="M5 11h14M5 7h14M5 15h10"></path>`,
    hora: `<circle cx="12" cy="12" r="8"></circle><path d="M12 8v5l3 2"></path>`,
    promedio: `<path d="M4 18V6m5 12V9m5 9V4m5 14v-7"></path>`,
    recibido: `<path d="M4 7l8-4 8 4-8 4-8-4z"></path><path d="M4 7v10l8 4 8-4V7"></path><path d="M12 11v10"></path>`,
    cumplimiento: `<path d="M5 13l4 4L19 7"></path>`,
    proveedor: `<path d="M4 18c1.5-3 4-5 8-5s6.5 2 8 5"></path><circle cx="12" cy="8" r="4"></circle>`,
    viaje: `<path d="M3 8h12v7H3z"></path><path d="M15 10h3l3 3v2h-6z"></path><circle cx="7" cy="17" r="2"></circle><circle cx="18" cy="17" r="2"></circle>`,
    pallet: `<path d="M5 6h14v10H5z"></path><path d="M5 11h14M8 16v3m8-3v3"></path>`,
    tienda: `<path d="M4 10h16l-2-5H6l-2 5z"></path><path d="M6 10v9h12v-9"></path><path d="M10 19v-5h4v5"></path>`,
    costo: `<path d="M12 3v18"></path><path d="M17 7c-1-2-8-2-8 1 0 4 8 2 8 6 0 3-7 3-9 1"></path>`,
    grafico: `<path d="M4 19V5"></path><path d="M4 19h16"></path><path d="M7 15l3-4 3 2 5-7"></path>`
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${base[tipo] || base.total}</svg>`;
}

function kpiMovil(icono, label, valor, nota = "") {
  return `
    <article>
      <i class="rf-kpi-icon">${iconoRf(icono)}</i>
      <span>${htmlSeguro(label)}</span>
      <strong>${valor}</strong>
      ${nota ? `<small>${nota}</small>` : ""}
    </article>
  `;
}

function pastelMovil(titulo, data, total, centro = "") {
  const filtrada = data.filter(x => x.valor > 0);
  if (!filtrada.length) return `<section class="rf-mobile-card"><div class="empty-mini">Sin datos para graficar ${htmlSeguro(titulo.toLowerCase())}.</div></section>`;
  const colores = ["#47765a", "#d39a36", "#5a2db3", "#315c7a", "#a24742", "#64748b"];
  const radio = 42;
  const circ = 2 * Math.PI * radio;
  let acumulado = 0;
  const segmentos = filtrada.map((item, index) => {
    const porcentaje = pct(item.valor, total);
    const largo = (porcentaje / 100) * circ;
    const offset = -((acumulado / 100) * circ);
    acumulado += porcentaje;
    return `<circle cx="60" cy="60" r="${radio}" fill="none" stroke="${colores[index % colores.length]}" stroke-width="19" stroke-dasharray="${largo} ${Math.max(0, circ - largo)}" stroke-dashoffset="${offset}" transform="rotate(-90 60 60)"></circle>`;
  }).join("");
  return `
    <section class="rf-mobile-card rf-mobile-pie-card">
      <div class="rf-mobile-section-title">
        <h3>${htmlSeguro(titulo)}</h3>
        <strong>${fmt(total)}</strong>
      </div>
      <div class="rf-mobile-pie-body">
        <svg viewBox="0 0 120 120" class="rf-mobile-pie">
          <circle cx="60" cy="60" r="${radio}" fill="none" stroke="#e7edf4" stroke-width="19"></circle>
          ${segmentos}
          <circle cx="60" cy="60" r="28" fill="#fff"></circle>
          <text x="60" y="57" text-anchor="middle">${htmlSeguro(centro || fmt(total))}</text>
          <text x="60" y="72" text-anchor="middle" class="sub">total</text>
        </svg>
        <div class="rf-mobile-pie-legend">
          ${filtrada.map((item, index) => `
            <span>
              <i style="background:${colores[index % colores.length]}"></i>
              <b>${htmlSeguro(item.label)}</b>
              <strong>${fmt(item.valor)}</strong>
              <small>${pct(item.valor, total).toFixed(1)}%</small>
            </span>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function detalleUsuariosPickingMovil(data, total) {
  const usuarios = usuariosPickingReporte(data);
  return `
    <section class="rf-mobile-card rf-mobile-users">
      <div class="rf-mobile-section-title">
        <h3>Usuarios que pickaron</h3>
        <strong>${fmt(usuarios.length)}</strong>
      </div>
      <div class="rf-mobile-user-list">
        ${usuarios.map((u, index) => `
          <article>
            <em>${index + 1}</em>
            <div>
              <strong>${htmlSeguro(u.nombre)}</strong>
              <small>${htmlSeguro(u.usuario)} | ${fmt(u.lpnsTotal)} LPNs | ${fmt(u.registros)} registros | ${pct(u.bultos, total).toFixed(1)}%</small>
              <span>${u.turnosDetalle.map(([turno, valor]) => `<b class="${turno.toLowerCase().replace(/\s/g, "-")}">${htmlSeguro(turno)} ${fmt(valor)}</b>`).join("")}</span>
            </div>
            <strong>${fmt(u.bultos)}</strong>
          </article>
        `).join("") || `<div class="empty-mini">Sin usuarios para este turno.</div>`}
      </div>
    </section>
  `;
}

function horasValorReporte(data, valueFn) {
  return agruparSuma(data, r => r.hora === null || r.hora === undefined ? "S/H" : `${String(r.hora).padStart(2, "0")}:00`, valueFn)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), "es", { numeric: true }));
}

function usuariosOperacionMovil(data, total, titulo, valueFn, unidad = "bultos") {
  const mapa = new Map();
  data.forEach(row => {
    const usuario = row.usuario || "SIN USUARIO";
    if (!mapa.has(usuario)) {
      mapa.set(usuario, { usuario, valor: 0, registros: 0, turnos: new Map() });
    }
    const item = mapa.get(usuario);
    const valor = valueFn(row);
    item.valor += valor;
    item.registros += 1;
    item.turnos.set(row.turno, (item.turnos.get(row.turno) || 0) + valor);
  });
  const usuarios = Array.from(mapa.values()).map(item => ({
    ...item,
    turnosDetalle: Array.from(item.turnos.entries()).sort((a, b) => {
      const orden = { DIA: 1, TARDE: 2, NOCHE: 3, "SIN TURNO": 4 };
      return (orden[a[0]] || 99) - (orden[b[0]] || 99);
    })
  })).sort((a, b) => b.valor - a.valor || b.registros - a.registros);
  return `
    <section class="rf-mobile-card rf-mobile-users">
      <div class="rf-mobile-section-title">
        <h3>${htmlSeguro(titulo)}</h3>
        <strong>${fmt(usuarios.length)}</strong>
      </div>
      <div class="rf-mobile-user-list">
        ${usuarios.map((u, index) => `
          <article>
            <em>${index + 1}</em>
            <div>
              <strong>${htmlSeguro(u.usuario)}</strong>
              <small>${fmt(u.registros)} registros | ${pct(u.valor, total).toFixed(1)}%</small>
              <span>${u.turnosDetalle.map(([turno, valor]) => `<b class="${turno.toLowerCase().replace(/\s/g, "-")}">${htmlSeguro(turno)} ${fmt(valor)}</b>`).join("")}</span>
            </div>
            <strong>${fmt(u.valor)}<small>${htmlSeguro(unidad)}</small></strong>
          </article>
        `).join("") || `<div class="empty-mini">Sin usuarios para este turno.</div>`}
      </div>
    </section>
  `;
}

function proveedoresRecepcionMovil(proveedores, total) {
  return `
    <section class="rf-mobile-card rf-mobile-users">
      <div class="rf-mobile-section-title">
        <h3>Proveedores recepcion</h3>
        <strong>${fmt(proveedores.length)}</strong>
      </div>
      <div class="rf-mobile-user-list">
        ${proveedores.slice(0, 12).map((p, index) => `
          <article>
            <em>${index + 1}</em>
            <div>
              <strong>${htmlSeguro(p.proveedor)}</strong>
              <small>${htmlSeguro(p.codigo)} | ASN ${fmt(p.asnUnicos)} | Pallets ${fmt(p.palletsTotal)}</small>
              <span>
                <b class="dia">Rec. ${fmt(p.recibido)}</b>
                <b class="${p.diferencia ? "tarde" : "dia"}">Dif. ${fmt(p.diferencia)}</b>
                <b>${p.cumplimiento.toFixed(1)}%</b>
              </span>
            </div>
            <strong>${pct(p.recibido, total).toFixed(1)}%</strong>
          </article>
        `).join("") || `<div class="empty-mini">Sin proveedores seleccionados.</div>`}
      </div>
    </section>
  `;
}

function palletsRecepcionReporte(data) {
  const mapa = new Map();
  data.forEach(r => {
    const key = r.lpn || `SIN LPN ${r.index}`;
    if (!mapa.has(key)) {
      mapa.set(key, {
        lpn: r.lpn || "SIN LPN",
        codigoProveedor: r.codigoProveedor,
        recibido: 0,
        programado: 0,
        codigos: new Set(),
        asns: new Set()
      });
    }
    const item = mapa.get(key);
    item.recibido += r.recibido;
    item.programado += r.programado;
    if (r.codigo) item.codigos.add(r.codigo);
    if (r.asn) item.asns.add(r.asn);
  });
  return Array.from(mapa.values()).map(item => ({
    ...item,
    tipo: item.codigos.size > 1 ? "MULTI" : "MONOPALLET",
    totalCodigos: item.codigos.size,
    totalAsn: item.asns.size
  }));
}

function resumenRecepcionRf(data, proveedores) {
  const pallets = palletsRecepcionReporte(data);
  const data917 = data.filter(r => normalizar(r.codigoProveedor) === "917");
  const pallets917 = pallets.filter(p => normalizar(p.codigoProveedor) === "917");
  const totalProgramado = proveedores.reduce((acc, p) => acc + p.programado, 0);
  const totalRecibido = proveedores.reduce((acc, p) => acc + p.recibido, 0);
  return {
    pallets,
    totalProgramado,
    totalRecibido,
    diferencia: totalProgramado - totalRecibido,
    cumplimiento: pctCumplimiento(totalRecibido, totalProgramado),
    proveedores: proveedores.length,
    asnUnicos: new Set(data.map(r => r.asn).filter(Boolean)).size,
    palletsTotal: pallets.length,
    paleterosRecibidos: new Set(data.map(r => r.asn).filter(asn => normalizar(asn).startsWith("OS917")).map(normalizar)).size,
    recibido917: data917.reduce((acc, r) => acc + r.recibido, 0),
    pallets917: pallets917.length,
    mono917: pallets917.filter(p => p.tipo === "MONOPALLET").length,
    multi917: pallets917.filter(p => p.tipo === "MULTI").length
  };
}

function indicadoresRecepcionMovil(resumen) {
  return `
    <section class="rf-mobile-card">
      <div class="rf-mobile-section-title">
        <h3>Indicadores recepcion</h3>
        <strong>${resumen.cumplimiento.toFixed(1)}%</strong>
      </div>
      <div class="rf-mobile-summary-grid">
        <article><span>ASN</span><strong>${fmt(resumen.asnUnicos)}</strong></article>
        <article><span>Pallets</span><strong>${fmt(resumen.palletsTotal)}</strong></article>
        <article><span>Punta Negra</span><strong>${fmt(resumen.recibido917)}</strong></article>
        <article><span>Mono 917</span><strong>${fmt(resumen.mono917)}</strong></article>
        <article><span>Multi 917</span><strong>${fmt(resumen.multi917)}</strong></article>
        <article><span>Diferencia</span><strong>${fmt(resumen.diferencia)}</strong></article>
      </div>
    </section>
  `;
}

function turnoDespachoPorHoraRf(hora) {
  if (hora === null || hora === undefined) return "SIN TURNO";
  if (hora >= 7 && hora < 19) return "DIA";
  if (hora >= 21 || hora < 7) return "NOCHE";
  return "SIN TURNO";
}

function codigoKey(valor) {
  return normalizar(valor).replace(/\s+/g, "").replace(/\.0+$/, "");
}

function cargaKey(valor) {
  return normalizar(valor).replace(/[^A-Z0-9]/g, "").replace(/\.0+$/, "");
}

function catalogoProductosDespachoRf() {
  const mapa = new Map();
  (dataProductosReporte || []).forEach(row => {
    const codigos = [
      campo(row, ["Cod Barra", "Cod. Barra", "CodBarra", "COD BARRA", "COD. BARRA", "Codigo", "CODIGO", "Codigo Producto", "CODIGO PRODUCTO"]),
      campo(row, ["CODIGO_ALT", "COD_ALT", "CODIGO ALTERNATIVO", "Cod Alternat", "Cod Altern", "COD ALTERN"])
    ].map(codigoKey).filter(Boolean);
    if (!codigos.length) return;
    const producto = {
      codigo: codigos[0],
      descripcion: limpiar(campo(row, ["Descripcion", "DESCRIPCION", "Descrip Artic", "Descrip Artic", "Producto", "PRODUCTO"])),
      undCaja: num(campo(row, ["Std Case Qty", "STD CASE QTY", "StdCaseQty", "STDCASEQTY", "Und x Caja", "UND X CAJA", "Und Caja", "UxC", "UNIDADES CAJA"])),
      costoUnidad: num(campo(row, ["Costo Unidad", "Costo unidad", "Costo Unitario", "Costo", "Precio", "PRECIO"])),
      jerarquia: limpiar(campo(row, ["Jerarq1", "JERARQ1", "Jerarquia", "JERARQUIA", "Familia", "FAMILIA"])) || "SIN JERARQUIA"
    };
    codigos.forEach(codigo => {
      if (!mapa.has(codigo)) mapa.set(codigo, producto);
    });
  });
  return mapa;
}

function capacidadCamionRf(paletas) {
  const valor = num(paletas);
  if (valor <= 0) return 0;
  if (valor <= 5) return 6;
  return [6, 8, 10, 12].reduce((mejor, actual) => {
    const diffActual = Math.abs(valor - actual);
    const diffMejor = Math.abs(valor - mejor);
    return diffActual < diffMejor || (diffActual === diffMejor && actual > mejor) ? actual : mejor;
  }, 6);
}

function cargasDespachoMapRf() {
  const mapa = new Map();
  (dataCargaReporte || []).forEach(row => {
    const carga = limpiar(campo(row, ["Nro Carga", "NRO CARGA", "Carga", "CARGA", "Nro Ola", "OLA"]));
    const key = cargaKey(carga);
    if (!key || mapa.has(key)) return;
    const fecha = fechaValor(campo(row, ["Fe Y Hr Modif", "Fe y Hr Modif", "FE Y HR MODIF", "Fecha de Envio", "Fecha Envio", "FECHA ENVIO", "Fecha"]));
    const horaCarga = horaFecha(fecha);
    const horaSeparada = horaValor(campo(row, ["Hora", "HORA", "Hora Envio", "HORA ENVIO", "Hr Modif", "HR MODIF", "Hora Carga", "HORA CARGA"]));
    const paletas = num(campo(row, ["No-LPN Paletas", "NO-LPN PALETAS", "No LPN Paletas", "Nro Paletas", "Paletas", "PALETAS"]));
    mapa.set(key, {
      carga,
      fecha,
      hora: horaSeparada !== null && horaSeparada !== undefined ? horaSeparada : horaCarga,
      placa: limpiar(campo(row, ["Nro Camion", "Nro CamiÃ³n", "NRO CAMION", "NRO CAMIÓN", "Placa", "PLACA"])),
      paradas: num(campo(row, ["Paradas", "PARADAS", "Nro Paradas", "NRO PARADAS"])),
      paletasDeclaradas: paletas,
      capacidad: capacidadCamionRf(paletas)
    });
  });
  return mapa;
}

function cargasDespachoListaRf(turno = "TODOS") {
  const cargas = Array.from(cargasDespachoMapRf().values());
  return turno === "TODOS" ? cargas : cargas.filter(carga => turnoDespachoPorHoraRf(carga.hora) === turno);
}

function viajesDespachoPorHoraRf(turno = "TODOS") {
  const mapa = new Map();
  cargasDespachoListaRf(turno).forEach(carga => {
    if (carga.hora === null || carga.hora === undefined) return;
    const key = String(carga.hora).padStart(2, "0");
    if (!mapa.has(key)) mapa.set(key, { label: `${key}:00`, valor: 0, registros: 0 });
    const item = mapa.get(key);
    item.valor += 1;
    item.registros += 1;
  });
  return Array.from(mapa.values()).sort((a, b) => Number(a.label.slice(0, 2)) - Number(b.label.slice(0, 2)));
}

function modeloDespachoReporte() {
  const cargas = cargasDespachoMapRf();
  const productos = catalogoProductosDespachoRf();
  return (dataCartonesReporte || []).map((r, index) => {
    const carga = limpiar(campo(r, ["Nro Carga", "NRO CARGA", "Carga", "CARGA", "Nro Ola", "OLA"]));
    const cargaInfo = cargas.get(cargaKey(carga));
    const fecha = cargaInfo?.fecha || fechaValor(campo(r, [
      "Hora de asignación de carga",
      "Hora de asignaciÃ³n de carga",
      "LPN Fe Y Hr Modif",
      "LPN Fe y Hr Modif",
      "Fe Hr Packing",
      "Fe Y Hr Modif",
      "Fe y Hr Modif",
      "FE Y HR MODIF",
      "Fecha",
      "FECHA"
    ]));
    const hora = horaFecha(fecha);
    const productoCodigo = codigoKey(campo(r, ["Cod Barra", "Cod. Barra", "CodBarra", "COD BARRA", "COD. BARRA", "Codigo", "CODIGO", "Codigo Producto", "CODIGO PRODUCTO", "Producto", "PRODUCTO"]));
    const producto = productos.get(productoCodigo);
    const unidades = num(campo(r, ["UnAct", "UNACT", "Un Act", "UN ACT", "Unidades", "UNIDADES", "Un Rcb", "UN RCB"]));
    const undCaja = producto?.undCaja || num(campo(r, ["Std Case Qty", "STD CASE QTY", "StdCaseQty", "STDCASEQTY", "Und x Caja", "UND X CAJA", "Und Caja", "UxC"]));
    const bultos = undCaja > 0 ? unidades / undCaja : 0;
    const costoUnidad = producto?.costoUnidad || 0;
    const destino = limpiar(campo(r, ["Destino", "DESTINO", "Cod Destino", "COD DESTINO", "Tienda", "TIENDA"]));
    const local = limpiar(campo(r, ["Nombre Destino", "NOMBRE DESTINO", "LOCAL", "TIENDA"])) || "SIN DESTINO";
    return {
      index,
      pallet: limpiar(campo(r, ["Nro Pallet", "NroPallet", "NRO PALLET", "PALLET", "Pallet"])),
      lpn: limpiar(campo(r, ["Nro LPNs", "Nro LPN", "NRO LPNS", "LPN"])),
      producto: productoCodigo,
      descripcion: producto?.descripcion || limpiar(campo(r, ["Descripcion", "DESCRIPCION", "Descrip Artic", "Descrip Artic"])),
      unidades,
      bultos,
      costo: unidades * costoUnidad,
      carga,
      destino,
      local,
      destinoKey: destino ? `${destino} | ${local}` : local,
      fecha,
      hora,
      turno: turnoDespachoPorHoraRf(hora),
      placa: cargaInfo?.placa || "",
      paradas: cargaInfo?.paradas || 0,
      paletasDeclaradas: cargaInfo?.paletasDeclaradas || 0,
      capacidadCamion: cargaInfo?.capacidad || 0
    };
  }).filter(r => r.pallet && r.carga && (r.bultos > 0 || r.unidades > 0));
}

function palletsDespachoRf(data) {
  const mapa = new Map();
  data.forEach(r => {
    const key = `${normalizar(r.carga)}|${normalizar(r.pallet)}`;
    if (!r.pallet || !key) return;
    if (!mapa.has(key)) {
      mapa.set(key, { pallet: r.pallet, bultos: 0, unidades: 0, costo: 0, productos: new Set(), destinos: new Set(), cargas: new Set() });
    }
    const item = mapa.get(key);
    item.bultos += r.bultos;
    item.unidades += r.unidades || 0;
    item.costo += r.costo || 0;
    if (r.producto) item.productos.add(r.producto);
    if (r.destinoKey) item.destinos.add(r.destinoKey);
    if (r.carga) item.cargas.add(r.carga);
  });
  return Array.from(mapa.values()).map(p => ({
    ...p,
    tipo: p.productos.size > 1 ? "MULTISKU" : "MONOPALLET",
    totalProductos: p.productos.size,
    totalDestinos: p.destinos.size
  }));
}

function resumenDespachoRf(data, turnoFiltro = "TODOS") {
  const cargasBase = cargasDespachoListaRf(turnoFiltro);
  const cargasData = new Set(data.map(r => r.carga).filter(Boolean)).size;
  const pallets = palletsDespachoRf(data);
  const totalBultos = data.reduce((a, b) => a + b.bultos, 0);
  const totalUnidades = data.reduce((a, b) => a + (b.unidades || 0), 0);
  const costoTotal = data.reduce((a, b) => a + (b.costo || 0), 0);
  const capacidadTotal = cargasBase.reduce((a, b) => a + (b.capacidad || 0), 0);
  return {
    pallets,
    totalBultos,
    totalUnidades,
    costoTotal,
    palletsTotal: pallets.length,
    viajes: cargasBase.length || cargasData,
    tiendas: new Set(data.map(r => r.destino).filter(Boolean)).size,
    placas: new Set(cargasBase.map(r => r.placa).filter(Boolean)).size || new Set(data.map(r => r.placa).filter(Boolean)).size,
    capacidadTotal,
    ocupacion: pct(cargasBase.reduce((a, b) => a + (b.paletasDeclaradas || 0), 0), capacidadTotal),
    bultosPallet: totalBultos / Math.max(pallets.length, 1),
    mono: pallets.filter(p => p.tipo === "MONOPALLET").length,
    multi: pallets.filter(p => p.tipo === "MULTISKU").length
  };
}

function cargasDespachoMovil(data) {
  const cargas = agruparSuma(data, r => r.carga, r => r.bultos).slice(0, 12);
  const total = data.reduce((acc, row) => acc + row.bultos, 0);
  return `
    <section class="rf-mobile-card rf-mobile-users">
      <div class="rf-mobile-section-title">
        <h3>Cargas despacho</h3>
        <strong>${fmt(cargas.length)}</strong>
      </div>
      <div class="rf-mobile-user-list">
        ${cargas.map((carga, index) => `
          <article>
            <em>${index + 1}</em>
            <div>
              <strong>${htmlSeguro(carga.label)}</strong>
              <small>${fmt(carga.registros)} registros | ${pct(carga.valor, total).toFixed(1)}%</small>
            </div>
            <strong>${fmt(carga.valor)}<small>bultos</small></strong>
          </article>
        `).join("") || `<div class="empty-mini">Sin cargas para este turno.</div>`}
      </div>
    </section>
  `;
}

function turnosDespachoMovil(dataGeneral, resumenGeneral) {
  const sinTurno = dataGeneral.filter(row => row.turno === "SIN TURNO");
  const turnos = sinTurno.length === dataGeneral.length ? ["SIN TURNO"] : ["DIA", "NOCHE"];
  return `
    <section class="rf-mobile-card rf-mobile-users">
      <div class="rf-mobile-section-title">
        <h3>Resumen por turno</h3>
        <strong>S/ ${fmt(resumenGeneral.costoTotal)}</strong>
      </div>
      <div class="rf-mobile-user-list">
        ${turnos.map((turno, index) => {
          const rows = dataGeneral.filter(row => row.turno === turno);
          const resumen = resumenDespachoRf(rows, turno);
          return `
            <article>
              <em>${index + 1}</em>
              <div>
                <strong>${turno}</strong>
                <small>${fmt(resumen.viajes)} viajes | ${fmt(resumen.palletsTotal)} pallets | ${fmt(resumen.tiendas)} tiendas</small>
                <span>
                  <b class="${turno.toLowerCase()}">S/ ${fmt(resumen.costoTotal)}</b>
                  <b>${fmt(resumen.bultosPallet)} b/pallet</b>
                </span>
              </div>
              <strong>${pct(resumen.costoTotal, resumenGeneral.costoTotal).toFixed(1)}%</strong>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function reporteDonutRecepcion(totalRecibido, diferencia, paleteros, proveedores) {
  const pendiente = Math.max(0, diferencia);
  const exceso = Math.max(0, -diferencia);
  const totalBase = Math.max(totalRecibido + pendiente + exceso, 1);
  const recibidoPct = pct(totalRecibido, totalBase);
  const pendientePct = pct(pendiente, totalBase);
  const excesoPct = pct(exceso, totalBase);
  const segmentos = [
    { label: "Recibido", valor: totalRecibido, pct: recibidoPct, color: "#47765a" },
    { label: "Diferencia", valor: pendiente, pct: pendientePct, color: "#bd7b2a" },
    { label: "Exceso", valor: exceso, pct: excesoPct, color: "#a24742" }
  ].filter(x => x.valor > 0 || x.label === "Recibido");
  let acumulado = 0;
  const radio = 39;
  const circ = 2 * Math.PI * radio;
  const svg = segmentos.map(seg => {
    const largo = (seg.pct / 100) * circ;
    const offset = -((acumulado / 100) * circ);
    acumulado += seg.pct;
    return `<circle cx="50" cy="50" r="${radio}" fill="none" stroke="${seg.color}" stroke-width="20" stroke-dasharray="${largo} ${Math.max(0, circ - largo)}" stroke-dashoffset="${offset}" transform="rotate(-90 50 50)"></circle>`;
  }).join("");
  return `
    <section class="rf-report-panel rf-reception-mix">
      <header><h3>COMPOSICION RECEPCION</h3><strong>${pctCumplimiento(totalRecibido, totalBase).toFixed(1)}%</strong></header>
      <div class="mix-body">
        <div class="mix-donut">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="${radio}" fill="none" stroke="#e5eaf1" stroke-width="20"></circle>
            ${svg}
          </svg>
          <div><strong>${fmt(totalRecibido)}</strong><span>recibido</span></div>
        </div>
        <div class="mix-list">
          ${segmentos.map(seg => `
            <article style="--tone:${seg.color}">
              <span>${htmlSeguro(seg.label)}</span>
              <strong>${fmt(seg.valor)}</strong>
              <b>${seg.pct.toFixed(1)}%</b>
            </article>
          `).join("")}
          <article style="--tone:#315c7a"><span>Paleteros</span><strong>${fmt(paleteros)}</strong><b>ASN OS917</b></article>
          <article style="--tone:#172438"><span>Proveedores</span><strong>${fmt(proveedores)}</strong><b>visibles</b></article>
        </div>
      </div>
    </section>
  `;
}

function esPuntaNegraRecepcionReporte(codigo) {
  return normalizar(codigo) === "917";
}

function codigoProveedorResumenRecepcionReporte(row) {
  return normalizar(campo(row, [
    "Proveedor",
    "CODIGO PROVEE",
    "CODIGO PROVEEDOR",
    "COD PROVEEDOR",
    "Codigo Proveedor",
    "CODIGO_PROVEEDOR"
  ]));
}

function bultosResumenProveedorRecepcionReporte(row) {
  const requerido = num(campo(row, ["Un Req", "UN REQ", "UN_REQ", "Unidades Requeridas"]));
  if (requerido > 0) return requerido;
  const bultos = num(campo(row, ["BULTOS", "Bultos", "BULTOS PROGRAMADOS", "PROGRAMADO"]));
  if (bultos > 0) return bultos;
  return num(campo(row, ["Un Env", "UN ENV", "UN_ENV", "Unidades Enviadas"]));
}

function ocResumenProveedorRecepcionReporte(row) {
  return normalizar(campo(row, ["Nro OC", "NRO OC", "OC", "Orden Compra", "ORDEN COMPRA"]));
}

function programadoProveedoresResumenRecepcionReporte(ocsRecepcionPorProveedor) {
  const mapa = new Map();
  (dataRecepcionProveedoresResumen || []).forEach(row => {
    const codigo = codigoProveedorResumenRecepcionReporte(row);
    if (!codigo || esPuntaNegraRecepcionReporte(codigo)) return;
    const oc = ocResumenProveedorRecepcionReporte(row);
    const ocsRecepcion = ocsRecepcionPorProveedor?.get(codigo);
    if (ocsRecepcion?.size && (!oc || !ocsRecepcion.has(oc))) return;
    const bultos = bultosResumenProveedorRecepcionReporte(row);
    if (bultos <= 0) return;
    mapa.set(codigo, (mapa.get(codigo) || 0) + bultos);
  });
  return mapa;
}

function proveedoresResumenReporte(data) {
  const mapa = new Map();
  const ocsRecepcionPorProveedor = new Map();
  data.forEach(r => {
    const codigoKey = normalizar(r.codigoProveedor);
    const ocKey = normalizar(r.oc);
    if (codigoKey && ocKey) {
      if (!ocsRecepcionPorProveedor.has(codigoKey)) ocsRecepcionPorProveedor.set(codigoKey, new Set());
      ocsRecepcionPorProveedor.get(codigoKey).add(ocKey);
    }
    if (!mapa.has(r.proveedorKey)) {
      mapa.set(r.proveedorKey, {
        key: r.proveedorKey,
        codigo: r.codigoProveedor,
        proveedor: r.proveedor,
        programadoReporte: 0,
        recibido: 0,
        recibidoUnidades: 0,
        registros: 0,
        asns: new Set(),
        pallets: new Set(),
        codigos: new Set()
      });
    }
    const item = mapa.get(r.proveedorKey);
    item.programadoReporte += r.programado;
    item.recibido += r.recibido;
    item.recibidoUnidades += r.unidadesRecibidas;
    item.registros += 1;
    if (r.asn) item.asns.add(r.asn);
    if (r.lpn) item.pallets.add(r.lpn);
    if (r.codigo) item.codigos.add(r.codigo);
  });
  const programadoResumen = programadoProveedoresResumenRecepcionReporte(ocsRecepcionPorProveedor);
  return Array.from(mapa.values()).map(item => {
    const codigo = normalizar(item.codigo);
    const programadoProveedor = programadoResumen.get(codigo) || 0;
    const usaResumenProveedor = !esPuntaNegraRecepcionReporte(codigo) && programadoProveedor > 0;
    const programado = usaResumenProveedor ? programadoProveedor : item.programadoReporte;
    const recibido = usaResumenProveedor ? item.recibidoUnidades : item.recibido;
    return {
      ...item,
      programado,
      recibido,
      programadoProveedor,
      fuenteProgramado: usaResumenProveedor ? "PROVEEDORES RESUMEN" : "REPORTE RECEPCION",
      diferencia: programado - recibido,
      cumplimiento: pctCumplimiento(recibido, programado),
      asnUnicos: item.asns.size,
      palletsTotal: item.pallets.size,
      codigosTotal: item.codigos.size
    };
  }).sort((a, b) => b.recibido - a.recibido);
}

function proveedoresVisiblesReporte(proveedores) {
  if (proveedoresReporteSeleccionados === null) return proveedores;
  return proveedores.filter(p => proveedoresReporteSeleccionados.has(p.key));
}

function cambiarTurnoReporte(turno) {
  turnoReportePicking = turno;
  renderReportes();
}

function cambiarTurnoDespachoRf(turno) {
  turnoReporteDespacho = turno;
  renderReportes();
}

function cambiarReporte(vista) {
  reporteActivo = vista;
  renderReportes();
}

function toggleProveedorReporte(key, checked) {
  if (proveedoresReporteSeleccionados === null) proveedoresReporteSeleccionados = new Set(proveedoresResumenReporte(modeloRecepcionReporte()).map(p => p.key));
  if (checked) proveedoresReporteSeleccionados.add(key);
  else proveedoresReporteSeleccionados.delete(key);
  renderReportes();
}

function setProveedoresReporte(modo) {
  proveedoresReporteSeleccionados = modo === "todos" ? null : new Set();
  renderReportes();
}

function mostrarApp() {
  document.getElementById("loginView").hidden = true;
  document.getElementById("appView").hidden = false;
  aplicarPermisosUsuario();
  actualizarTituloModuloRf();
  cambiarVistaRf(vistaRf);
  recargarDatos(false);
}

function actualizarVistaRf() {
  if (!datosListos) return;
  if (datosOperativosListos) registrarTareasTrabajoRemoto();
  if (vistaRf === "validacion") renderValidacionPlusMovil();
  else if (vistaRf === "asignacion") renderAsignacionOperacionalMovil();
  else if (vistaRf === "trabajo") renderTrabajoAsignacionMovil();
  else if (vistaRf === "topPicking") renderTopPickingDashboard();
  else if (vistaRf === "reportes") renderReportes();
}

function mostrarLogin() {
  document.getElementById("loginView").hidden = false;
  document.getElementById("appView").hidden = true;
  setTimeout(() => document.getElementById("usuario")?.focus(), 80);
}

function validarLogin(event) {
  event.preventDefault();
  const user = normalizar(document.getElementById("usuario").value);
  const pass = limpiar(document.getElementById("password").value);
  const perfil = RF_USUARIOS[user];
  if (!perfil || pass !== perfil.password) {
    document.getElementById("loginError").textContent = "Usuario o contrasena incorrecta.";
    document.getElementById("password").select();
    return;
  }
  usuarioActivo = { codigo: user, perfil };
  vistaRf = vistaInicialUsuario();
  document.getElementById("loginError").textContent = "";
  mostrarApp();
}

function salir() {
  detenerCamara();
  usuarioActivo = null;
  vistaRf = "consulta";
  aplicarPermisosUsuario();
  document.getElementById("password").value = "";
  mostrarLogin();
}

async function recargarDatos(forzar = true) {
  if (datosListos && !forzar) {
    estado(`${fmt(dataLPN.length)} LPNs | data lista`);
    if (vistaRf === "validacion") renderValidacionPlusMovil();
    else if (vistaRf === "asignacion") renderAsignacionOperacionalMovil();
    else if (vistaRf === "trabajo") renderTrabajoAsignacionMovil();
    else if (vistaRf === "dashboard") renderDashboardTrabajo();
    else if (vistaRf === "topPicking") renderTopPickingDashboard();
    else if (vistaRf === "reportes") renderReportes();
    else enfocarLpn();
    return;
  }
  const botones = [document.getElementById("refreshButton"), document.getElementById("headerRefreshButton")].filter(Boolean);
  botones.forEach(boton => {
    boton.disabled = true;
    boton.textContent = "Leyendo...";
  });
  try {
    await cargarDatos();
    cacheValidacionPlus = null;
    if (vistaRf === "validacion") renderValidacionPlusMovil();
    else if (vistaRf === "asignacion") renderAsignacionOperacionalMovil();
    else if (vistaRf === "trabajo") renderTrabajoAsignacionMovil();
    else if (vistaRf === "dashboard") renderDashboardTrabajo();
    else if (vistaRf === "topPicking") renderTopPickingDashboard();
    else if (vistaRf === "reportes") renderReportes();
    else enfocarLpn();
  } catch (error) {
    estado("Error al cargar data");
    mostrarMensaje("No se pudo cargar LPNS", error.message || String(error), true);
  } finally {
    botones.forEach(boton => {
      boton.disabled = false;
      boton.textContent = boton.id === "headerRefreshButton" ? "Actualizar" : "Actualizar data";
    });
  }
}

function enfocarLpn() {
  setTimeout(() => {
    const input = document.getElementById("lpnInput");
    if (!input || document.getElementById("appView").hidden) return;
    input.focus();
    input.select();
  }, 80);
}

function buscarManual(event) {
  event.preventDefault();
  buscarConsulta(document.getElementById("lpnInput").value);
}

function buscarConsulta(valor) {
  const q = normalizar(valor);
  if (!q) return enfocarLpn();
  if (!datosListos) {
    limpiarSeleccionConsulta();
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a escanear.");
    return;
  }

  limpiarSeleccionConsulta();
  const rows = indiceLpn.get(q) || [];
  document.getElementById("lpnInput").value = "";
  ocultarSugerencias();
  if (rows.length) {
    renderLpn(rows);
    return enfocarLpn();
  }

  const producto = buscarProductoPorCodigo(q);
  if (!producto) {
    mostrarMensaje("No encontrado", `No existe LPN ni codigo ${q}.`, true);
    return enfocarLpn();
  }

  renderProductoConsulta(producto);
  enfocarLpn();
}

function tonoEstado(estado, ubicacion) {
  const e = normalizar(estado);
  const u = normalizar(ubicacion);
  if (e.includes("UBIC") && u.startsWith("MASS")) return "ok";
  if (!u) return "warn";
  if (u.includes("PLUS") || u.includes("DROP") || u.includes("BUFFER")) return "warn";
  return "";
}

function ordenarUbicacion(a, b) {
  const parse = u => {
    const p = limpiar(u).split("-");
    return [num(p[1]), num(p[2]), num(p[3]), num(p[4])];
  };
  const pa = parse(a);
  const pb = parse(b);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2] || pa[3] - pb[3];
}

function esCapacidadDinamica(uniMax) {
  const valor = num(uniMax);
  return valor <= 0 || valor >= 999999;
}

function disponibilidadPorCapacidad(uniMax, unact, transito, uxb) {
  const dinamica = esCapacidadDinamica(uniMax);
  const disponibleUnd = dinamica ? CAPACIDAD_DINAMICA_UND : Math.max(0, num(uniMax) - (num(unact) + num(transito)));
  return {
    dinamica,
    disponibleUnd,
    disponibleBul: uxb ? disponibleUnd / uxb : disponibleUnd
  };
}

function fmtDisp(valor, dinamica) {
  return dinamica ? "SIN LIMITE" : fmt(valor);
}

function estadoOperativo(row) {
  const estado = normalizar(row.estado);
  return estado === "UBICADO" || estado === "RECIBIDO";
}

function productoInfo(codigo, row = {}) {
  const producto = productoPorCodigo(codigo);
  return {
    codigo: normalizar(codigo),
    codigoAlt: row.codigoAlt || producto?.codigoAlt || "",
    estilo: row.estilo || producto?.estilo || "",
    descripcion: row.descripcion || producto?.descripcion || "",
    uxb: producto?.uxb || 1
  };
}

function buscarProductoPorCodigo(q) {
  const exacto = normalizar(q);
  const producto = (indiceProducto.get(exacto) || dataProductos.find(row =>
    row.codigo === exacto ||
    normalizar(row.codigoAlt) === exacto ||
    normalizar(row.estilo) === exacto
  )) || dataProductos.find(row => normalizar(row.estilo).includes(exacto) && exacto.length >= 3);
  if (producto) {
    return {
      codigo: producto.codigo,
      codigoAlt: producto.codigoAlt,
      estilo: producto.estilo,
      descripcion: producto.descripcion,
      uxb: producto.uxb || 1,
      bultos: 0,
      unidades: 0,
      lineas: 0
    };
  }

  const lpn = dataLPN.find(row =>
    normalizar(row.codigo) === exacto ||
    normalizar(row.codigoAlt) === exacto ||
    normalizar(row.estilo) === exacto
  ) || dataLPN.find(row => normalizar(row.estilo).includes(exacto) && exacto.length >= 3);
  if (lpn) {
    const info = productoInfo(lpn.codigo, lpn);
    return {
      ...info,
      bultos: 0,
      unidades: 0,
      lineas: 0
    };
  }

  const activo = dataInventario.find(row =>
    row.codigo === exacto ||
    normalizar(row.codigoAlt) === exacto ||
    normalizar(row.estilo) === exacto
  ) || dataInventario.find(row => normalizar(row.estilo).includes(exacto) && exacto.length >= 3);
  if (activo) {
    return {
      codigo: activo.codigo,
      codigoAlt: activo.codigoAlt,
      estilo: activo.estilo,
      descripcion: activo.descripcion,
      uxb: activo.uxb || 1,
      bultos: 0,
      unidades: 0,
      lineas: 0
    };
  }

  return null;
}

function textoProductoSugerencia(producto) {
  return [
    producto.codigo,
    producto.codigoAlt,
    producto.estilo,
    producto.descripcion
  ].map(normalizar).join(" ");
}

function crearProductoDesdeFuente(row) {
  const info = productoInfo(row.codigo || row.PRODUCTO || row.CODIGO, row);
  return {
    codigo: info.codigo,
    codigoAlt: info.codigoAlt,
    estilo: info.estilo,
    descripcion: info.descripcion,
    uxb: info.uxb || 1,
    bultos: 0,
    unidades: 0,
    lineas: 0
  };
}

function sugerenciasLpn(q) {
  const exacto = normalizar(q);
  const vistos = new Map();
  dataLPN.forEach(row => {
    const lpn = normalizar(row.lpn);
    if (!lpn) return;
    const coincide = lpn.includes(exacto) || (exacto.length >= 4 && lpn.endsWith(exacto));
    if (!coincide) return;
    if (!vistos.has(lpn)) {
      vistos.set(lpn, {
        tipo: "LPN",
        valor: row.lpn,
        titulo: row.lpn,
        subtitulo: `${row.ubicacion || "SIN UBICACION"} | ${row.estado || "SIN ESTADO"}`,
        meta: 0
      });
    }
    vistos.get(lpn).meta += num(row.bultos);
  });
  return Array.from(vistos.values()).sort((a, b) => b.meta - a.meta).slice(0, 8);
}

function sugerenciasProducto(q) {
  const exacto = normalizar(q);
  const mapa = new Map();
  const agregar = producto => {
    if (!producto?.codigo || mapa.has(producto.codigo)) return;
    if (!textoProductoSugerencia(producto).includes(exacto)) return;
    const lpns = lpnsProducto(producto);
    mapa.set(producto.codigo, {
      tipo: "CODIGO",
      valor: producto.codigo,
      titulo: `${producto.codigo}${producto.codigoAlt ? ` | ${producto.codigoAlt}` : ""}`,
      subtitulo: producto.estilo ? `Estilo ${producto.estilo} | ${producto.descripcion || "Sin descripcion"}` : (producto.descripcion || "Sin descripcion"),
      meta: lpns.reduce((a, b) => a + b.bultos, 0)
    });
  };

  dataProductos.forEach(agregar);
  dataLPN.forEach(row => agregar(crearProductoDesdeFuente(row)));
  dataInventario.forEach(row => agregar(crearProductoDesdeFuente(row)));
  return Array.from(mapa.values()).sort((a, b) => b.meta - a.meta || a.titulo.localeCompare(b.titulo)).slice(0, 8);
}

function mostrarSugerenciasBusqueda() {
  const box = document.getElementById("sugerenciasBusqueda");
  const q = limpiar(document.getElementById("lpnInput")?.value);
  const n = normalizar(q);
  if (!box || !datosListos || n.length < 3) return ocultarSugerencias();

  const sugerencias = [...sugerenciasLpn(n), ...sugerenciasProducto(n)].slice(0, 10);
  if (!sugerencias.length) return ocultarSugerencias();

  box.innerHTML = sugerencias.map(item => `
    <button type="button" class="suggestion-item" data-value="${atributoSeguro(item.valor)}">
      <span>${htmlSeguro(item.tipo)}</span>
      <b>${htmlSeguro(item.titulo)}</b>
      <small>${htmlSeguro(item.subtitulo)}${item.meta ? ` | ${fmt(item.meta)} bul` : ""}</small>
    </button>
  `).join("");
  box.hidden = false;
}

function programarSugerenciasBusqueda() {
  clearTimeout(timerSugerencias);
  timerSugerencias = setTimeout(mostrarSugerenciasBusqueda, 80);
}

function ocultarSugerencias() {
  const box = document.getElementById("sugerenciasBusqueda");
  if (!box) return;
  box.hidden = true;
  box.innerHTML = "";
}

function manejarClickSugerencia(event) {
  const boton = event.target.closest(".suggestion-item");
  if (!boton) return;
  if (event.type === "click" && boton.dataset.pointerHandled === "1") return;
  if (event.type === "pointerdown") boton.dataset.pointerHandled = "1";
  event.preventDefault();
  event.stopPropagation();
  clearTimeout(timerSugerencias);
  buscarConsulta(boton.dataset.value || "");
}

function consolidarProductosLpn(rows) {
  const mapa = new Map();
  rows.forEach(row => {
    const codigo = normalizar(row.codigo);
    if (!codigo) return;
    const info = productoInfo(codigo, row);
    if (!mapa.has(codigo)) {
      mapa.set(codigo, {
        codigo,
        codigoAlt: info.codigoAlt,
        descripcion: info.descripcion,
        uxb: info.uxb,
        bultos: 0,
        unidades: 0,
        lineas: 0
      });
    }
    const item = mapa.get(codigo);
    item.bultos += num(row.bultos);
    item.unidades += num(row.unidades || row.bultos);
    item.lineas += 1;
  });
  return Array.from(mapa.values()).sort((a, b) => b.bultos - a.bultos || a.codigo.localeCompare(b.codigo));
}

function codigosComparablesProducto(producto) {
  return new Set([
    normalizar(producto?.codigo),
    normalizar(producto?.codigoAlt)
  ].filter(Boolean));
}

function inventarioCoincideProducto(row, producto) {
  const claves = codigosComparablesProducto(producto);
  const codigo = normalizar(row.codigo);
  const codigoAlt = normalizar(row.codigoAlt);
  return (codigo && claves.has(codigo)) || (codigoAlt && claves.has(codigoAlt));
}

function activoProducto(producto) {
  const agrupado = new Map();
  dataInventario
    .filter(row => inventarioCoincideProducto(row, producto) && row.ubicacion)
    .forEach(row => {
      const key = `${normalizar(row.codigo || producto.codigo)}|${normalizar(row.ubicacion)}`;
      if (!agrupado.has(key)) {
        agrupado.set(key, {
          ubicacion: row.ubicacion,
          codigo: producto.codigo,
          codigoAlt: producto.codigoAlt || row.codigoAlt || "",
          descripcion: producto.descripcion || row.descripcion || "",
          uniMax: 0,
          capacidadDinamica: false,
          asignado: 0,
          transito: 0,
          bultos: 0,
          unidades: 0,
          disponibleUnidades: 0,
          disponibleBultos: 0,
          filas: 0,
          uxb: row.uxb || producto.uxb || 1
        });
      }
      const item = agrupado.get(key);
      const uxb = row.uxb || item.uxb || producto.uxb || 1;
      item.unidades += row.unact;
      item.bultos += row.bultos;
      item.asignado += row.uniAsig;
      item.transito += row.transito;
      item.uniMax = Math.max(item.uniMax, row.uniMax);
      item.capacidadDinamica = item.capacidadDinamica || esCapacidadDinamica(row.uniMax);
      item.uxb = uxb;
      item.filas += 1;
    });

  return Array.from(agrupado.values()).map(row => {
    const disp = disponibilidadPorCapacidad(row.capacidadDinamica ? 0 : row.uniMax, row.unidades, row.transito, row.uxb);
    const faltaUnd = disp.dinamica ? 0 : Math.max(0, producto.unidades - disp.disponibleUnd);
    const faltaBul = disp.dinamica ? 0 : Math.max(0, producto.bultos - disp.disponibleBul);
    return {
      ...row,
      uniAsig: row.asignado,
      capacidadDinamica: disp.dinamica,
      disponibleUnidades: disp.disponibleUnd,
      disponibleBultos: disp.disponibleBul,
      ingresa: disp.dinamica || disp.disponibleUnd >= producto.unidades,
      ingresaParcial: !disp.dinamica && disp.disponibleUnd > 0 && disp.disponibleUnd < producto.unidades,
      faltaUnd,
      faltaBul
    };
  }).sort((a, b) => Number(b.ingresa) - Number(a.ingresa) || b.disponibleBultos - a.disponibleBultos || ordenarUbicacion(a.ubicacion, b.ubicacion));
}

function reservaProducto(producto, lpnOrigen) {
  const mapa = new Map();
  dataLPN
    .filter(row => row.codigo && normalizar(row.codigo) === producto.codigo)
    .filter(row => row.lpn !== lpnOrigen)
    .filter(row => estadoOperativo(row))
    .filter(row => normalizar(row.ubicacion).startsWith("MASS-"))
    .forEach(row => {
      const key = `${normalizar(row.lpn)}|${normalizar(row.ubicacion)}`;
      if (!mapa.has(key)) {
        mapa.set(key, {
          lpn: row.lpn,
          ubicacion: row.ubicacion || "SIN UBICACION",
          estado: row.estado || "SIN ESTADO",
          codigo: normalizar(row.codigo),
          codigoAlt: row.codigoAlt || producto.codigoAlt,
          descripcion: row.descripcion || producto.descripcion,
          bultos: 0,
          unidades: 0,
          fecha: row.fecha
        });
      }
      const item = mapa.get(key);
      item.bultos += num(row.bultos);
      item.unidades += num(row.unidades || row.bultos);
    });
  return Array.from(mapa.values()).sort((a, b) => ordenarUbicacion(a.ubicacion, b.ubicacion) || b.bultos - a.bultos);
}

function resumenDecision(producto, activos, reservas) {
  const activoOk = activos.find(row => row.ingresa);
  const activoParcial = activos.find(row => row.ingresaParcial);
  if (activoOk) {
    return {
      clase: "ok",
      titulo: "INGRESA A ACTIVO",
      detalle: `${activoOk.ubicacion} recibe ${fmt(producto.bultos)} bultos.`
    };
  }
  if (reservas.length) {
    return {
      clase: "warn",
      titulo: "ACOPLAR EN RESERVA",
      detalle: `${reservas[0].ubicacion} / ${reservas[0].lpn}`
    };
  }
  if (activoParcial) {
    return {
      clase: "warn",
      titulo: "ACTIVO PARCIAL",
      detalle: `${activoParcial.ubicacion} recibe ${fmtDisp(activoParcial.disponibleBultos, activoParcial.capacidadDinamica)} bultos.`
    };
  }
  return {
    clase: "bad",
    titulo: "SETEAR UBICACION",
    detalle: "Sin activo completo ni reserva MASS."
  };
}

function renderActivoMovil(activos) {
  if (!activos.length) {
    return `<div class="empty-mini bad">Sin ubicacion activa para este codigo.</div>`;
  }
  return activos.map(row => `
    <div class="dest-row ${row.ingresa ? "ok" : row.ingresaParcial ? "warn" : ""}">
      <div>
        <strong>${htmlSeguro(row.ubicacion)}</strong>
        <span>Stock ${fmt(row.bultos)} bul | Asig ${fmt(row.uniAsig)} | Tran ${fmt(row.transito)}</span>
      </div>
      <b>${row.ingresa ? "SI" : row.ingresaParcial ? "PARCIAL" : "NO"}</b>
      <small>${fmtDisp(row.disponibleBultos, row.capacidadDinamica)} disp. bul</small>
    </div>
  `).join("");
}

function renderReservaMovil(reservas) {
  if (!reservas.length) {
    return `<div class="empty-mini warn">No hay reserva MASS. Producto para setear si no ingresa a activo.</div>`;
  }
  return reservas.map(row => `
    <div class="dest-row warn">
      <div>
        <strong>${htmlSeguro(row.ubicacion)}</strong>
        <span>${htmlSeguro(row.lpn)} | ${htmlSeguro(row.estado)}</span>
      </div>
      <b>${fmt(row.bultos)}</b>
      <small>bultos</small>
    </div>
  `).join("");
}

function lpnsProducto(producto) {
  const mapa = new Map();
  dataLPN
    .filter(row => normalizar(row.codigo) === producto.codigo)
    .forEach(row => {
      const key = `${normalizar(row.lpn)}|${normalizar(row.ubicacion)}`;
      if (!mapa.has(key)) {
        mapa.set(key, {
          lpn: row.lpn,
          ubicacion: row.ubicacion || "SIN UBICACION",
          estado: row.estado || "SIN ESTADO",
          bultos: 0,
          unidades: 0
        });
      }
      const item = mapa.get(key);
      item.bultos += num(row.bultos);
      item.unidades += num(row.unidades || row.bultos);
    });
  return Array.from(mapa.values()).sort((a, b) => ordenarUbicacion(a.ubicacion, b.ubicacion) || b.bultos - a.bultos);
}

function campoPedido(row, nombres) {
  for (const nombre of nombres) {
    if (row[nombre] !== undefined && row[nombre] !== null && row[nombre] !== "") return row[nombre];
  }
  const keys = Object.keys(row || {});
  for (const nombre of nombres) {
    const found = keys.find(k => normalizar(k) === normalizar(nombre));
    if (found && row[found] !== undefined && row[found] !== null && row[found] !== "") return row[found];
  }
  return "";
}

function codigoPedido(row) {
  return normalizar(campoPedido(row, ["PRODUCTO", "Producto", "CODIGO", "Codigo"]));
}

function codigoAltPedido(row) {
  return limpiar(campoPedido(row, [
    "CODIGO_ALT",
    "COD_ALT",
    "CODIGO ALTERNATIVO",
    "Codigo Alternativo",
    "Cod Alternat",
    "Cod Altern",
    "Codigo alternativo"
  ]));
}

function descripcionPedido(row) {
  return limpiar(campoPedido(row, ["DESCRIPCION", "Descripcion", "Descripción", "DESCRIPCION_PRODUCTO"]));
}

function bultosNoAsignadoPedido(row) {
  return num(campoPedido(row, [
    "BULTOS_NO_ASIGNADO",
    "BULTOS_NO_ASIGNADOS",
    "BULTO_NO_ASIGNADO",
    "BULTO_NO_ASIGANDO",
    "BULTOS_NO_ASIGANDO",
    "NO_ASIGNADO",
    "NO ASIGNADO"
  ]));
}

function obtenerPedidoNoAsignadoRf() {
  const mapa = new Map();
  (dataPedido || []).forEach(row => {
    const codigo = codigoPedido(row);
    const bultos = bultosNoAsignadoPedido(row);
    if (!codigo || bultos <= 0) return;
    if (!mapa.has(codigo)) {
      const producto = productoPorCodigo(codigo);
      mapa.set(codigo, {
        codigo,
        codigoAlt: codigoAltPedido(row) || producto?.codigoAlt || "",
        estilo: producto?.estilo || "",
        descripcion: descripcionPedido(row) || producto?.descripcion || "",
        total: 0
      });
    }
    const item = mapa.get(codigo);
    item.total += bultos;
    if (!item.codigoAlt) item.codigoAlt = codigoAltPedido(row);
    if (!item.descripcion) item.descripcion = descripcionPedido(row);
  });
  return Array.from(mapa.values());
}

function bultosPedidoTotalAsignacionRf(row) {
  return num(campoPedido(row, ["BULTOS_PEDIDO", "BULTOS PEDIDO", "PEDIDO", "BULTOS"]));
}

function fechaPedidoKpiAsignacionRf(row) {
  const valor = campoPedido(row, [
    "FECHA_ORDEN",
    "FECHA ORDEN",
    "Fecha Orden",
    "FECHA",
    "Fecha",
    "FECHA PEDIDO",
    "Fecha Pedido",
    "FECHA_PEDIDO"
  ]);
  const texto = limpiar(valor);
  const partes = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (partes) {
    const dia = Number(partes[1]);
    const mes = Number(partes[2]) - 1;
    const anio = Number(partes[3]) < 100 ? 2000 + Number(partes[3]) : Number(partes[3]);
    return new Date(anio, mes, dia);
  }
  return fechaValor(valor);
}

function fechaPedidoKpiKey(fecha) {
  if (!fecha) return "";
  return String(new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()).getTime());
}

function fechaPedidoKpiTexto(fecha) {
  if (!fecha) return "";
  return fecha.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fechasPedidoKpiAsignacion() {
  const mapa = new Map();
  (dataPedido || []).forEach(row => {
    const fecha = fechaPedidoKpiAsignacionRf(row);
    const key = fechaPedidoKpiKey(fecha);
    if (key && !mapa.has(key)) mapa.set(key, { key, fecha, label: fechaPedidoKpiTexto(fecha) });
  });
  return Array.from(mapa.values()).sort((a, b) => Number(b.key) - Number(a.key));
}

function fechaPedidoKpiActiva() {
  const fechas = fechasPedidoKpiAsignacion();
  if (!fechas.length) return "";
  if (!fechaPedidoKpiAsignacion || !fechas.some(item => item.key === fechaPedidoKpiAsignacion)) {
    fechaPedidoKpiAsignacion = fechas[0].key;
  }
  return fechaPedidoKpiAsignacion;
}

function pedidoKpiAsignacionPorFecha(totalOriginal) {
  const fechaActiva = fechaPedidoKpiActiva();
  if (!fechaActiva) return { pedido: totalOriginal, fecha: "" };
  const fecha = fechasPedidoKpiAsignacion().find(item => item.key === fechaActiva);
  const pedido = (dataPedido || []).reduce((acc, row) => {
    const fechaRow = fechaPedidoKpiKey(fechaPedidoKpiAsignacionRf(row));
    return fechaRow === fechaActiva ? acc + bultosPedidoTotalAsignacionRf(row) : acc;
  }, 0);
  return { pedido, fecha: fecha?.label || "" };
}

function filtroFechaPedidoKpiAsignacion() {
  const fechas = fechasPedidoKpiAsignacion();
  if (!fechas.length) return "";
  const activa = fechaPedidoKpiActiva();
  return `
    <label class="rf-mobile-filter">Fecha pedido
      <select onchange="cambiarFechaPedidoKpiAsignacion(this.value)">
        ${fechas.map(item => `<option value="${item.key}" ${item.key === activa ? "selected" : ""}>${htmlSeguro(item.label)}</option>`).join("")}
      </select>
    </label>
  `;
}

function cambiarFechaPedidoKpiAsignacion(valor) {
  fechaPedidoKpiAsignacion = limpiar(valor);
  renderAsignacionOperacionalMovil();
}

function bultosAsignadosPedidoRf(row) {
  return num(campoPedido(row, [
    "BULTOS_ASIGNADOS",
    "BULTOS_ASIGANDOS",
    "BULTOS_ASIGNADO",
    "BULTO_ASIGNADO",
    "ASIGNADO"
  ]));
}

function resumenPedidoAsignacionRf() {
  return (dataPedido || []).reduce((acc, row) => {
    acc.pedido += bultosPedidoTotalAsignacionRf(row);
    acc.asignado += bultosAsignadosPedidoRf(row);
    acc.noAsignado += bultosNoAsignadoPedido(row);
    return acc;
  }, { pedido: 0, asignado: 0, noAsignado: 0 });
}

function ubicacionTipoValidacion(ubicacion) {
  const u = normalizar(ubicacion);
  if (u.startsWith("MASS-")) return "reserva";
  if (!u || u.startsWith("DROP-BUFR") || u.startsWith("RAMPA-") || u.startsWith("DROP-STOCK-DESBLOQ-962")) return "otras";
  return "ignorar";
}

function pasilloReservaRf(ubicacion) {
  const p = limpiar(ubicacion).toUpperCase().split("-");
  if (p[0] !== "MASS" || !p[1]) return "";
  return String(Number(p[1]) || p[1]).padStart(2, "0");
}

function lpnsStockProducto(codigo) {
  return (indiceLpnCodigo.get(codigo) || []).filter(row =>
    (normalizar(row.estado) === "UBICADO" || normalizar(row.estado) === "RECIBIDO")
  );
}

function elegirStockRf(rows, requerido) {
  const utiles = rows
    .map(row => ({ row, stock: num(row.bultos) }))
    .filter(x => x.stock > 0)
    .sort((a, b) => a.stock - b.stock);
  let restante = requerido;
  const usados = [];
  for (const item of utiles) {
    if (restante <= 0) break;
    const tomar = Math.min(restante, item.stock);
    usados.push({ ...item, tomar });
    restante -= tomar;
  }
  return usados;
}

function elegirLpnsAsignacionRf(rows, requerido) {
  const utiles = rows
    .map(row => ({ row, stock: num(row.bultos) }))
    .filter(x => x.stock > 0);
  let bestFit = null;
  for (const item of utiles) {
    if (item.stock >= requerido && (!bestFit || item.stock < bestFit.stock)) bestFit = item;
  }
  if (bestFit) return [{ row: bestFit.row, tomar: requerido, stock: bestFit.stock, highlight: true }];
  let restante = requerido;
  const usados = [];
  utiles.sort((a, b) => b.stock - a.stock);
  for (const item of utiles) {
    if (restante <= 0) break;
    const tomar = Math.min(restante, item.stock);
    usados.push({ row: item.row, tomar, stock: item.stock, highlight: false });
    restante -= tomar;
  }
  return usados;
}

function activosValidacionProducto(item, requerido) {
  const producto = productoPorCodigo(item.codigo) || {};
  const uxb = producto.uxb || 1;
  const agrupados = new Map();
  dataInventario
    .filter(row => row.codigo === item.codigo || normalizar(row.codigoAlt) === normalizar(item.codigoAlt))
    .filter(row => row.ubicacion)
    .forEach(row => {
      const key = row.ubicacion;
      if (!agrupados.has(key)) {
        agrupados.set(key, {
          row,
          stock: 0
        });
      }
      const disponibleUnd = Math.max(0, num(row.unact) - num(row.uniAsig));
      const rowUxb = row.uxb || uxb || 1;
      agrupados.get(key).stock += rowUxb ? disponibleUnd / rowUxb : disponibleUnd;
    });
  return elegirStockRf(Array.from(agrupados.values()).map(x => ({
    ...x.row,
    bultos: x.stock,
    lpn: `ACTIVO ${x.row.ubicacion}`
  })), requerido);
}

function procesarAsignacionOperacionalRf() {
  const pedido = obtenerPedidoNoAsignadoRf();
  const tablaReserva = [];
  const tablaOtras = [];
  const sinStock = [];
  const productos = [];

  pedido.forEach(item => {
    const stock = lpnsStockProducto(item.codigo);
    const reserva = stock.filter(row => ubicacionTipoValidacion(row.ubicacion) === "reserva");
    const otras = stock.filter(row => ubicacionTipoValidacion(row.ubicacion) === "otras");
    const activos = activosValidacionProducto(item, item.total);
    const stockActivo = activos.reduce((acc, row) => acc + num(row.stock), 0);
    const stockReserva = reserva.reduce((acc, row) => acc + num(row.bultos), 0);
    const stockOtras = otras.reduce((acc, row) => acc + num(row.bultos), 0);
    let restante = item.total;
    let asignadoActivo = 0;
    let asignadoReserva = 0;
    let asignadoOtras = 0;

    activos.forEach(usado => {
      const tomar = Math.min(restante, usado.tomar);
      if (tomar <= 0) return;
      asignadoActivo += tomar;
      restante -= tomar;
    });

    const pedidoReserva = Math.min(restante, stockReserva);
    elegirLpnsAsignacionRf(reserva, restante).forEach(usado => {
      const tomar = Math.min(restante, usado.tomar);
      if (tomar <= 0) return;
      tablaReserva.push({
        codigo: item.codigo,
        codigoAlt: item.codigoAlt,
        desc: item.descripcion,
        lpn: usado.row.lpn,
        ubicacion: usado.row.ubicacion,
        requerido: pedidoReserva,
        requerimientoTotal: item.total,
        cs: usado.stock,
        bultos: usado.stock,
        asignar: tomar,
        restante: usado.stock - tomar,
        highlight: usado.highlight,
        origen: "reserva",
        grupo: pasilloReservaRf(usado.row.ubicacion) || "SIN"
      });
      asignadoReserva += tomar;
      restante -= tomar;
    });

    const pedidoOtras = restante;
    elegirLpnsAsignacionRf(otras, restante).forEach(usado => {
      const tomar = Math.min(restante, usado.tomar);
      if (tomar <= 0) return;
      tablaOtras.push({
        codigo: item.codigo,
        codigoAlt: item.codigoAlt,
        desc: item.descripcion,
        lpn: usado.row.lpn,
        ubicacion: usado.row.ubicacion || "SIN UBICACION",
        requerido: pedidoOtras,
        requerimientoTotal: item.total,
        cs: usado.stock,
        bultos: usado.stock,
        asignar: tomar,
        restante: usado.stock - tomar,
        highlight: usado.highlight,
        origen: "otras"
      });
      asignadoOtras += tomar;
      restante -= tomar;
    });

    if (restante > 0) {
      sinStock.push({
        codigo: item.codigo,
        codigoAlt: item.codigoAlt,
        desc: item.descripcion,
        bultos: restante,
        estado: stockActivo + stockReserva + stockOtras > 0 ? "STOCK INSUFICIENTE" : "SIN STOCK"
      });
    }

    productos.push({
      ...item,
      stockActivo,
      stockReserva,
      stockOtras,
      asignadoActivo,
      asignadoReserva,
      asignadoOtras,
      sinCobertura: Math.max(0, restante)
    });
  });

  const resumenPedido = resumenPedidoAsignacionRf();
  const resumen = productos.reduce((acc, row) => {
    acc.requerido += row.total;
    acc.activo += row.asignadoActivo;
    acc.reserva += row.asignadoReserva;
    acc.otras += row.asignadoOtras;
    acc.sinCobertura += row.sinCobertura;
    acc.productos += 1;
    if (row.sinCobertura > 0) acc.productosSinCobertura += 1;
    if (row.stockActivo + row.stockReserva + row.stockOtras <= 0) acc.productosSinStock += 1;
    return acc;
  }, { requerido: 0, activo: 0, reserva: 0, otras: 0, sinCobertura: 0, productos: 0, productosSinCobertura: 0, productosSinStock: 0 });
  resumen.pedido = resumenPedido.pedido;
  resumen.asignado = resumenPedido.asignado;
  resumen.noAsignado = resumenPedido.noAsignado;
  resumen.asignable = Math.max(0, resumenPedido.pedido - resumenPedido.asignado);
  resumen.stockAsignable = resumen.activo + resumen.reserva + resumen.otras;
  resumen.cobertura = resumen.noAsignado > 0 ? (resumen.stockAsignable / resumen.noAsignado) * 100 : 0;

  return {
    reserva: tablaReserva.sort((a, b) => String(a.ubicacion || "").localeCompare(String(b.ubicacion || ""), "es", { numeric: true })),
    otras: tablaOtras.sort((a, b) => b.asignar - a.asignar),
    sinStock: sinStock.sort((a, b) => b.bultos - a.bultos),
    productos,
    resumen
  };
}

function agruparCodPlusRf() {
  const porLpn = new Map();
  dataLPN
    .filter(row => normalizar(row.ubicacion) === "DROP-COD-PLUS-ALM")
    .filter(row => ["UBICADO", "ASIGNACION PARCIAL", "ASIGNACIÓN PARCIAL"].includes(normalizar(row.estado)))
    .forEach(row => {
      const codigo = normalizar(row.codigo);
      const lpn = limpiar(row.lpn);
      if (!codigo || !lpn) return;
      const key = `${codigo}|${lpn}`;
      if (!porLpn.has(key)) {
        porLpn.set(key, {
          codigo,
          lpn,
          ubicacion: row.ubicacion,
          estado: row.estado,
          bultos: 0,
          unidades: 0
        });
      }
      const item = porLpn.get(key);
      item.bultos += num(row.bultos);
      item.unidades += num(row.unidades || row.bultos);
    });

  const porProducto = new Map();
  porLpn.forEach(row => {
    if (!porProducto.has(row.codigo)) porProducto.set(row.codigo, { bultos: 0, lpns: [] });
    const item = porProducto.get(row.codigo);
    item.bultos += row.bultos;
    item.lpns.push(row);
  });
  return porProducto;
}

function estadoValidacionPlusRf(pedido, codPlus, pedidoOriginal, activo) {
  const difFila = codPlus - pedido;
  const sobranteReal = Math.max(0, codPlus - pedidoOriginal);
  if (codPlus <= 0) return { texto: "Sin avance", clase: "bad", difFila, sobranteReal };
  if (Math.abs(difFila) < 0.0001) return { texto: "Completo", clase: "ok", difFila, sobranteReal };
  if (difFila < 0) return { texto: "Falta", clase: "warn", difFila, sobranteReal };
  if (sobranteReal <= 0.0001 && activo > 0) return { texto: "Conciliable", clase: "warn", difFila, sobranteReal };
  return { texto: "Sobrante real", clase: "bad", difFila, sobranteReal };
}

function obtenerValidacionPlusRf() {
  if (cacheValidacionPlus) return cacheValidacionPlus;
  const pedido = obtenerPedidoNoAsignadoRf();
  const codPlus = agruparCodPlusRf();
  const codPlusRestante = new Map();
  codPlus.forEach((value, codigo) => codPlusRestante.set(codigo, value.bultos));
  const filas = [];

  pedido.forEach(item => {
    const stock = lpnsStockProducto(item.codigo);
    const reserva = stock.filter(row => ubicacionTipoValidacion(row.ubicacion) === "reserva");
    const otras = stock.filter(row => ubicacionTipoValidacion(row.ubicacion) === "otras");
    let restante = item.total;
    let asignadoActivo = 0;

    activosValidacionProducto(item, restante).forEach(usado => {
      const tomar = Math.min(restante, usado.tomar);
      asignadoActivo += tomar;
      restante -= tomar;
    });

    elegirStockRf(reserva, restante).forEach(usado => {
      const tomar = Math.min(restante, usado.tomar);
      if (tomar <= 0) return;
      filas.push({
        origen: "RESERVA",
        grupo: pasilloReservaRf(usado.row.ubicacion) || "SIN",
        codigo: item.codigo,
        codigoAlt: item.codigoAlt,
        descripcion: item.descripcion,
        pedidoOriginal: item.total,
        activo: asignadoActivo,
        pedido: tomar,
        lpnOrigen: usado.row.lpn,
        ubicacionOrigen: usado.row.ubicacion
      });
      restante -= tomar;
    });

    elegirStockRf(otras, restante).forEach(usado => {
      const tomar = Math.min(restante, usado.tomar);
      if (tomar <= 0) return;
      filas.push({
        origen: "OTRAS",
        grupo: "OTRAS",
        codigo: item.codigo,
        codigoAlt: item.codigoAlt,
        descripcion: item.descripcion,
        pedidoOriginal: item.total,
        activo: asignadoActivo,
        pedido: tomar,
        lpnOrigen: usado.row.lpn,
        ubicacionOrigen: usado.row.ubicacion || "SIN UBICACION"
      });
      restante -= tomar;
    });

    if (restante > 0) {
      filas.push({
        origen: "SIN_STOCK",
        grupo: "SIN_STOCK",
        codigo: item.codigo,
        codigoAlt: item.codigoAlt,
        descripcion: item.descripcion,
        pedidoOriginal: item.total,
        activo: asignadoActivo,
        pedido: restante,
        lpnOrigen: "",
        ubicacionOrigen: "SIN STOCK"
      });
    }
  });

  filas.forEach(row => {
    const plus = codPlus.get(row.codigo) || { bultos: 0, lpns: [] };
    const disponible = codPlusRestante.get(row.codigo) || 0;
    const asignado = Math.min(row.pedido, disponible);
    codPlusRestante.set(row.codigo, Math.max(0, disponible - asignado));
    row.codPlus = asignado;
    row.lpnsCodPlus = plus.lpns;
    Object.assign(row, estadoValidacionPlusRf(row.pedido, row.codPlus, row.pedidoOriginal, row.activo));
  });

  codPlusRestante.forEach((sobrante, codigo) => {
    if (sobrante <= 0) return;
    const candidatas = filas.filter(row => row.codigo === codigo);
    if (!candidatas.length) return;
    const row = candidatas[candidatas.length - 1];
    row.codPlus += sobrante;
    Object.assign(row, estadoValidacionPlusRf(row.pedido, row.codPlus, row.pedidoOriginal, row.activo));
  });

  cacheValidacionPlus = filas.sort((a, b) =>
    (a.origen === "RESERVA" ? 1 : a.origen === "OTRAS" ? 2 : 3) - (b.origen === "RESERVA" ? 1 : b.origen === "OTRAS" ? 2 : 3) ||
    String(a.grupo).localeCompare(String(b.grupo), "es", { numeric: true }) ||
    b.pedido - a.pedido
  );
  return cacheValidacionPlus;
}

function resumenGrupoValidacionRf(data) {
  return data.reduce((acc, row) => {
    acc.filas += 1;
    acc.pedido += row.pedido;
    acc.plus += row.codPlus;
    acc.faltan += Math.max(0, row.pedido - row.codPlus);
    acc.sobrante += Math.max(0, row.sobranteReal);
    return acc;
  }, { filas: 0, pedido: 0, plus: 0, faltan: 0, sobrante: 0 });
}

function tarjetaValidacionRf(row, index) {
  return `
    <button type="button" class="validation-item ${row.clase}" data-index="${index}">
      <span class="product-main">
        <b>${htmlSeguro(row.codigo)}${row.codigoAlt ? ` | ${htmlSeguro(row.codigoAlt)}` : ""}</b>
        <small>${htmlSeguro(row.descripcion || "Sin descripcion")}</small>
      </span>
      <span class="validation-numbers">
        <b>${fmt(row.pedido)}</b>
        <small>Pedido</small>
      </span>
      <span class="validation-badge ${row.clase}">${htmlSeguro(row.texto)}</span>
      <span class="validation-meta">${htmlSeguro(row.ubicacionOrigen || "-")} | Plus ${fmt(row.codPlus)} | Dif ${fmt(row.difFila)}</span>
    </button>
  `;
}

function bloqueValidacionRf(titulo, data, abierto = false) {
  if (!data.length) return "";
  const resumen = resumenGrupoValidacionRf(data);
  return `
    <details class="validation-block" ${abierto ? "open" : ""}>
      <summary>
        <span>
          <b>${htmlSeguro(titulo)}</b>
          <small>${fmt(resumen.filas)} filas | ${fmt(resumen.pedido)} pedido | ${fmt(resumen.plus)} Plus</small>
        </span>
        <strong>${fmt(resumen.faltan)}</strong>
      </summary>
      <div class="validation-list">
        ${data.map(row => tarjetaValidacionRf(row, row._index)).join("")}
      </div>
    </details>
  `;
}

function renderValidacionPlusMovil() {
  if (!datosListos) {
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a abrir la validacion.");
    return;
  }
  if (!datosOperativosListos) {
    mostrarMensaje("Data operativa cargando", "LPNS ya esta lista. Espera a que termine PEDIDO, PRODUCTOS e INV_ACTIVO.");
    return;
  }
  const data = obtenerValidacionPlusRf().map((row, index) => ({ ...row, _index: index }));
  const resumen = resumenGrupoValidacionRf(data);
  const reserva = data.filter(row => row.origen === "RESERVA");
  const bloquesReserva = Array.from({ length: 12 }, (_, i) => {
    const pasillo = String(i + 1).padStart(2, "0");
    return bloqueValidacionRf(`Reserva pasillo ${pasillo}`, reserva.filter(row => row.grupo === pasillo), i === 0);
  }).join("");
  const sinPasillo = bloqueValidacionRf("Reserva sin pasillo", reserva.filter(row => !/^\d{2}$/.test(row.grupo)));
  const otras = bloqueValidacionRf("Otras ubicaciones", data.filter(row => row.origen === "OTRAS"), false);
  const sinStock = bloqueValidacionRf("Sin stock", data.filter(row => row.origen === "SIN_STOCK"), false);

  document.getElementById("resultado").innerHTML = `
    <article class="result-card validation-screen">
      <div class="result-head">
        <span>Validacion Plus</span>
        <strong>No asignado</strong>
      </div>
      <div class="kpi-grid">
        <div class="mini-kpi"><span>Filas</span><strong>${fmt(resumen.filas)}</strong></div>
        <div class="mini-kpi"><span>Pedido</span><strong>${fmt(resumen.pedido)}</strong></div>
        <div class="mini-kpi ok"><span>Plus</span><strong>${fmt(resumen.plus)}</strong></div>
        <div class="mini-kpi bad"><span>Faltan</span><strong>${fmt(resumen.faltan)}</strong></div>
      </div>
      <div class="validation-groups">
        ${bloquesReserva}${sinPasillo}${otras}${sinStock || `<div class="empty-mini">Sin productos sin stock.</div>`}
      </div>
    </article>
  `;
}

function resumenPasillosAsignacionRf(reserva) {
  const mapa = new Map();
  reserva.forEach(row => {
    const pasillo = row.grupo || pasilloReservaRf(row.ubicacion) || "SIN";
    if (!mapa.has(pasillo)) {
      mapa.set(pasillo, { pasillo, bultos: 0, ubicaciones: new Set(), lpns: new Set(), lineas: 0 });
    }
    const item = mapa.get(pasillo);
    item.bultos += row.asignar;
    item.lineas += 1;
    if (row.ubicacion) item.ubicaciones.add(row.ubicacion);
    if (row.lpn) item.lpns.add(row.lpn);
  });
  return Array.from(mapa.values()).map(item => ({
    ...item,
    ubicacionesTotal: item.ubicaciones.size,
    lpnsTotal: item.lpns.size
  })).sort((a, b) => String(a.pasillo).localeCompare(String(b.pasillo), "es", { numeric: true }));
}

function claveAsignacionOperativa(row) {
  return [row.origen, row.codigo, row.lpn, row.ubicacion, row.asignar].map(limpiar).join("|");
}

function estaCompletaAsignacion(row) {
  return estadoAsignacionOperativa[claveAsignacionOperativa(row)] === "completo";
}

async function toggleAsignacionOperativa(key) {
  if (!key || guardandoTrabajo.has(key)) return;
  const anterior = estadoAsignacionOperativa[key] === "completo" ? "completo" : "pendiente";
  const siguiente = anterior === "completo" ? "pendiente" : "completo";

  if (apiTrabajoDisponible() && !operadorTrabajo) {
    operadorTrabajo = limpiar(window.prompt("Nombre del operador:", "") || "");
    if (!operadorTrabajo) return;
    localStorage.setItem("rf_trabajo_operador", operadorTrabajo);
  }

  estadoAsignacionOperativa[key] = siguiente;
  localStorage.setItem("rf_asignacion_operativa_estado", JSON.stringify(estadoAsignacionOperativa));
  renderTrabajoAsignacionMovil();

  if (!apiTrabajoDisponible()) return;
  guardandoTrabajo.add(key);
  try {
    const fila = obtenerFilaTrabajoPorClave(key) || {};
    const response = await fetch(urlApiTrabajo(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "ACTUALIZAR",
        registro: {
          clave: key,
          estado: siguiente === "completo" ? "COMPLETO" : "PENDIENTE",
          operador: operadorTrabajo,
          origen: fila.origen,
          codigo: fila.codigo,
          ubicacion: fila.ubicacion,
          lpn: fila.lpn,
          bultos: fila.asignar
        }
      })
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      if (data.conflicto) estadoAsignacionOperativa[key] = "completo";
      else estadoAsignacionOperativa[key] = anterior;
      localStorage.setItem("rf_asignacion_operativa_estado", JSON.stringify(estadoAsignacionOperativa));
      renderTrabajoAsignacionMovil();
      window.alert(data.mensaje || "No se pudo guardar el avance.");
    }
  } catch (error) {
    estadoAsignacionOperativa[key] = anterior;
    localStorage.setItem("rf_asignacion_operativa_estado", JSON.stringify(estadoAsignacionOperativa));
    renderTrabajoAsignacionMovil();
    window.alert("No se pudo sincronizar el avance. Revisa la conexion e intenta nuevamente.");
  } finally {
    guardandoTrabajo.delete(key);
  }
}

function obtenerFilaTrabajoPorClave(key) {
  const data = procesarAsignacionOperacionalRf();
  return [...data.reserva, ...data.otras].find(row => claveAsignacionOperativa(row) === key);
}

async function limpiarAvanceAsignacionOperativa() {
  if (!window.confirm("Se eliminara todo el avance del dia. Esta accion no se puede deshacer. ¿Continuar?")) return;
  if (apiTrabajoDisponible()) {
    try {
      const response = await fetch(urlApiTrabajo(), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "RESET" })
      });
      const result = await response.json();
      if (!response.ok || result.ok === false) throw new Error(result.mensaje || "No se pudo reiniciar el avance.");
    } catch (error) {
      window.alert(error.message || "No se pudo reiniciar el avance remoto.");
      return;
    }
  }
  estadoAsignacionOperativa = {};
  estadoTrabajoRemoto = {};
  firmaEstadoTrabajoRemoto = "";
  tareasTrabajoRegistradas = false;
  registrandoTareasTrabajo = false;
  localStorage.removeItem("rf_asignacion_operativa_estado");
  renderTrabajoAsignacionMovil();
}

function cambiarFiltroTrabajoAsignacion(valor) {
  filtroTrabajoAsignacion = limpiar(valor);
  clearTimeout(timerFiltroTrabajoAsignacion);
  timerFiltroTrabajoAsignacion = setTimeout(() => {
    const data = procesarAsignacionOperacionalRf();
    const reserva = filtrarTrabajoAsignacion(data.reserva);
    const otras = filtrarTrabajoAsignacion(data.otras);
    const trabajo = [...reserva, ...otras];
    const progreso = document.getElementById("trabajoAsignacionProgreso");
    const reservaBox = document.getElementById("trabajoAsignacionReserva");
    const otrasBox = document.getElementById("trabajoAsignacionOtras");
    if (progreso) progreso.innerHTML = progresoAsignacionMovil(trabajo, false);
    if (reservaBox) reservaBox.innerHTML = detalleTrabajoAsignacionMovil("Reserva MASS", reserva, true, false, true);
    if (otrasBox) otrasBox.innerHTML = detalleTrabajoAsignacionMovil("Otras ubicaciones", otras, false, false, false);
  }, 90);
}

function filtrarTrabajoAsignacion(rows) {
  const q = normalizar(filtroTrabajoAsignacion);
  if (!q) return rows;
  return rows.filter(row => [
    row.origen,
    row.grupo,
    row.ubicacion,
    row.lpn,
    row.codigo,
    row.codigoAlt,
    row.desc
  ].map(normalizar).some(texto => texto.includes(q)));
}

function avanceAsignacionOperativa(rows) {
  return rows.reduce((acc, row) => {
    const valor = num(row.asignar);
    acc.total += valor;
    acc.filas += 1;
    if (estaCompletaAsignacion(row)) {
      acc.completado += valor;
      acc.completas += 1;
    }
    return acc;
  }, { total: 0, completado: 0, filas: 0, completas: 0 });
}

function ordenarTrabajoAsignacion(rows) {
  return rows.slice().sort((a, b) =>
    String(a.ubicacion || "").localeCompare(String(b.ubicacion || ""), "es", { numeric: true }) ||
    String(a.lpn || "").localeCompare(String(b.lpn || ""), "es", { numeric: true })
  );
}

function pasilloTrabajoAsignacion(row) {
  const grupo = Number(row.grupo);
  if (Number.isInteger(grupo) && grupo >= 1 && grupo <= 12) return grupo;
  const partes = limpiar(row.ubicacion).toUpperCase().split("-");
  const pasillo = Number(partes[1]);
  return Number.isInteger(pasillo) && pasillo >= 1 && pasillo <= 12 ? pasillo : null;
}

function bloquesReservaTrabajoAsignacion(rows) {
  const grupos = new Map();
  rows.forEach(row => {
    const pasillo = pasilloTrabajoAsignacion(row);
    const clave = pasillo === null ? "SIN" : String(pasillo);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(row);
  });
  return Array.from(grupos.entries()).sort(([a], [b]) => {
    if (a === "SIN") return 1;
    if (b === "SIN") return -1;
    return Number(a) - Number(b);
  });
}

function pasillosAsignacionMovil(rows, totalReserva) {
  const pasillos = resumenPasillosAsignacionRf(rows.filter(row => row.origen === "reserva"));
  return `
    <section class="rf-mobile-card assignment-aisles">
      <div class="rf-mobile-section-title">
        <h3>Reserva por pasillo</h3>
        <strong>${fmt(pasillos.length)}</strong>
      </div>
      <div class="assignment-aisle-list">
        ${pasillos.map(p => `
          <article>
            <div>
              <strong>Pasillo ${htmlSeguro(p.pasillo)}</strong>
              <span>${fmt(p.ubicacionesTotal)} ubic. | ${fmt(p.lpnsTotal)} LPNs | ${fmt(p.lineas)} lineas</span>
            </div>
            <b>${fmt(p.bultos)}</b>
            <i><u style="width:${Math.min(100, pct(p.bultos, totalReserva))}%"></u></i>
          </article>
        `).join("") || `<div class="empty-mini">Sin reserva MASS para asignar.</div>`}
      </div>
    </section>
  `;
}

function progresoAsignacionMovil(rows, envoltura = true) {
  const avance = avanceAsignacionOperativa(rows);
  const porcentaje = pct(avance.completado, avance.total);
  const contenido = `
    <div class="rf-mobile-section-title">
      <h3>Avance operativo</h3>
      <strong>${porcentaje.toFixed(1)}%</strong>
    </div>
    <div class="assignment-progress">
      <div><i style="width:${Math.min(100, porcentaje)}%"></i></div>
      <span>${fmt(avance.completado)} de ${fmt(avance.total)} bultos | ${fmt(avance.completas)} de ${fmt(avance.filas)} tareas</span>
    </div>
    <button type="button" class="assignment-reset" onclick="limpiarAvanceAsignacionOperativa()">Reiniciar avance</button>
  `;
  return envoltura ? `
    <section class="rf-mobile-card assignment-progress-card">
      ${contenido}
    </section>
  ` : contenido;
}

function tarjetaTrabajoAsignacion(row, index) {
  const completa = estaCompletaAsignacion(row);
  const key = atributoSeguro(claveAsignacionOperativa(row));
  return `
    <article class="${completa ? "done" : ""}">
      <em>${index + 1}</em>
      <div>
        <strong>${htmlSeguro(row.ubicacion || "-")}</strong>
        <small>${htmlSeguro(row.codigo)} | ${htmlSeguro(row.desc || "Sin descripcion")}</small>
        <span>
          <b class="${row.origen === "reserva" ? "dia" : "tarde"}">${row.origen === "reserva" ? "RESERVA" : "OTRAS"}</b>
          <b>LPN ${htmlSeguro(row.lpn || "-")}</b>
          <b>Stock ${fmt(row.bultos)}</b>
        </span>
      </div>
      <div class="assignment-work-side">
        <strong>${fmt(row.asignar)}<small>bultos</small></strong>
        <button type="button" class="${completa ? "done" : ""}" data-assignment-key="${key}">${completa ? "Reabrir" : "Completar"}</button>
      </div>
    </article>
  `;
}

function detalleTrabajoAsignacionMovil(titulo, rows, abierto = false, envoltura = true, segmentarPasillos = false) {
  const ordenadas = ordenarTrabajoAsignacion(rows);
  const avance = avanceAsignacionOperativa(ordenadas);
  const lista = segmentarPasillos
    ? bloquesReservaTrabajoAsignacion(ordenadas).map(([clave, grupo]) => {
      const resumenGrupo = avanceAsignacionOperativa(grupo);
      return `
        <section class="assignment-aisle-group">
          <div class="assignment-aisle-heading">
            <strong>${clave === "SIN" ? "Sin pasillo" : `Pasillo ${clave}`}</strong>
            <span>${fmt(resumenGrupo.completado)} / ${fmt(resumenGrupo.total)} bultos</span>
          </div>
          <div class="rf-mobile-user-list assignment-reserve-list">
            ${grupo.map((row, index) => tarjetaTrabajoAsignacion(row, index)).join("")}
          </div>
        </section>
      `;
    }).join("")
    : `<div class="rf-mobile-user-list assignment-reserve-list">
        ${ordenadas.map((row, index) => tarjetaTrabajoAsignacion(row, index)).join("") || `<div class="empty-mini">Sin tareas para mostrar.</div>`}
      </div>`;
  const contenido = `
    <summary>
      <span>${htmlSeguro(titulo)}</span>
      <strong>${fmt(avance.completado)} / ${fmt(avance.total)}</strong>
    </summary>
    <div class="rf-mobile-section-title">
      <h3>${htmlSeguro(titulo)}</h3>
      <strong>${pct(avance.completado, avance.total).toFixed(1)}%</strong>
    </div>
    ${lista || `<div class="empty-mini">Sin tareas para mostrar.</div>`}
  `;
  return envoltura ? `
    <details class="rf-mobile-card rf-mobile-users assignment-work-block" ${abierto ? "open" : ""}>
      ${contenido}
    </details>
  ` : contenido;
}

function renderAsignacionOperacionalMovil() {
  if (!datosListos) {
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a abrir asignacion.");
    return;
  }
  if (!datosOperativosListos) {
    cargarDatosOperativos();
    mostrarMensaje("Data operativa cargando", "LPNS ya esta lista. Espera a que termine la data de asignacion.");
    return;
  }
  const data = procesarAsignacionOperacionalRf();
  const reserva = data.reserva;
  const otras = data.otras;
  const resumen = data.resumen;
  const pedidoKpi = pedidoKpiAsignacionPorFecha(resumen.pedido);
  const ubicacionesReserva = new Set(reserva.map(row => row.ubicacion).filter(Boolean)).size;
  const ubicacionesOtras = new Set(otras.map(row => row.ubicacion).filter(Boolean)).size;
  const totalReserva = reserva.reduce((acc, row) => acc + row.asignar, 0);
  const totalOtras = otras.reduce((acc, row) => acc + row.asignar, 0);
  document.getElementById("resultado").innerHTML = `
    <article class="result-card reports-module assignment-module">
      <section class="rf-report-sheet assignment rf-mobile-picking rf-mobile-report">
        <div class="rf-mobile-title green">
          <span>Modulo RF</span>
          <h2>Asignacion Operacional</h2>
        </div>
        ${filtroFechaPedidoKpiAsignacion()}
        <div class="rf-mobile-kpis">
          ${kpiMovil("total", "Pedido total", fmt(pedidoKpi.pedido), pedidoKpi.fecha ? `Bultos del pedido | ${pedidoKpi.fecha}` : "Bultos del pedido")}
          ${kpiMovil("grafico", "No asignado", fmt(resumen.noAsignado), "Pendiente operacional")}
          ${kpiMovil("cumplimiento", "Sin stock", fmt(resumen.sinCobertura), `${fmt(data.sinStock.length)} productos`)}
          ${kpiMovil("pallet", "Ubic. reserva", fmt(ubicacionesReserva), `${fmt(totalReserva)} bultos MASS`)}
          ${kpiMovil("tienda", "Otras ubic.", fmt(ubicacionesOtras), `${fmt(totalOtras)} bultos apoyo`)}
        </div>
        ${pastelMovil("Cobertura no asignado", [
          { label: "Activo", valor: resumen.activo },
          { label: "Reserva", valor: resumen.reserva },
          { label: "Otras", valor: resumen.otras },
          { label: "Sin stock", valor: resumen.sinCobertura }
        ], Math.max(resumen.noAsignado, resumen.activo + resumen.reserva + resumen.otras + resumen.sinCobertura, 1), `${Math.min(100, resumen.cobertura).toFixed(1)}%`)}
        ${pastelMovil("Solo reserva MASS", [
          { label: "Reserva", valor: resumen.reserva },
          { label: "No cubierto", valor: Math.max(0, resumen.noAsignado - resumen.reserva) }
        ], Math.max(resumen.noAsignado, 1), "MASS")}
        ${pastelMovil("Reserva vs otras", [
          { label: "Reserva MASS", valor: resumen.reserva },
          { label: "Otras ubicaciones", valor: resumen.otras }
        ], Math.max(resumen.reserva + resumen.otras, 1), "Apoyo")}
        ${pasillosAsignacionMovil(reserva, Math.max(totalReserva, 1))}
      </section>
    </article>
  `;
}

function renderTrabajoAsignacionMovil() {
  if (!datosListos) {
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a abrir trabajo.");
    return;
  }
  if (!datosOperativosListos) {
    cargarDatosOperativos();
    mostrarMensaje("Data operativa cargando", "LPNS ya esta lista. Espera a que termine la data de asignacion.");
    return;
  }
  iniciarSincronizacionTrabajo();
  registrarTareasTrabajoRemoto();
  const data = procesarAsignacionOperacionalRf();
  const reservaBase = data.reserva;
  const otrasBase = data.otras;
  const reserva = filtrarTrabajoAsignacion(reservaBase);
  const otras = filtrarTrabajoAsignacion(otrasBase);
  const trabajo = [...reserva, ...otras];
  const totalReserva = reservaBase.reduce((acc, row) => acc + row.asignar, 0);
  document.getElementById("resultado").innerHTML = `
    <article class="result-card reports-module assignment-module">
      <section class="rf-report-sheet assignment rf-mobile-picking rf-mobile-report">
        <div class="rf-mobile-title green">
          <span>Operacion RF</span>
          <h2>Trabajo No Asignado</h2>
        </div>
        <label class="rf-mobile-filter">Buscar por pasillo, ubicacion, LPN o codigo
          <input value="${atributoSeguro(filtroTrabajoAsignacion)}" oninput="cambiarFiltroTrabajoAsignacion(this.value)" placeholder="Ej: 05, MASS-05, CT962, codigo">
        </label>
        <section id="trabajoAsignacionProgreso" class="rf-mobile-card assignment-progress-card">${progresoAsignacionMovil(trabajo, false)}</section>
        ${pasillosAsignacionMovil(reservaBase, Math.max(totalReserva, 1))}
        <details id="trabajoAsignacionReserva" class="rf-mobile-card rf-mobile-users assignment-work-block" open>${detalleTrabajoAsignacionMovil("Reserva MASS", reserva, true, false, true)}</details>
        <details id="trabajoAsignacionOtras" class="rf-mobile-card rf-mobile-users assignment-work-block">${detalleTrabajoAsignacionMovil("Otras ubicaciones", otras, false, false, false)}</details>
      </section>
    </article>
  `;
}

function pasilloDashboardTrabajo(ubicacion) {
  const partes = limpiar(ubicacion).toUpperCase().split("-");
  const pasillo = Number(partes[1]);
  return Number.isInteger(pasillo) && pasillo >= 1 && pasillo <= 12 ? pasillo : null;
}

function renderDashboardTrabajo() {
  if (!apiTrabajoDisponible()) {
    mostrarMensaje("Dashboard no configurado", "Falta conectar la URL de Google Apps Script.");
    return;
  }
  iniciarSincronizacionTrabajo();
  const dataTrabajoActual = datosOperativosListos ? procesarAsignacionOperacionalRf() : { reserva: [], otras: [] };
  const tareasActuales = [...dataTrabajoActual.reserva, ...dataTrabajoActual.otras];
  const tareasPorClave = new Map(tareasActuales.map(row => [claveAsignacionOperativa(row), row]));
  const estados = Object.entries(estadoTrabajoRemoto || {}).map(([clave, estado]) => {
    const tarea = tareasPorClave.get(clave);
    return {
      ...estado,
      ubicacion: tarea?.ubicacion || estado.ubicacion,
      bultos: tarea ? num(tarea.asignar) : num(estado.bultos)
    };
  });
  const total = estados.length;
  const completos = estados.filter(row => normalizar(row.estado) === "COMPLETO");
  const pendientes = Math.max(0, total - completos.length);
  const bultosTotal = estados.reduce((acc, row) => acc + num(row.bultos), 0);
  const bultosCompletos = completos.reduce((acc, row) => acc + num(row.bultos), 0);
  const bultosPendientes = Math.max(0, bultosTotal - bultosCompletos);
  const porcentaje = pct(bultosCompletos, bultosTotal);
  const pasillos = new Map();
  estados.forEach(row => {
    const pasillo = pasilloDashboardTrabajo(row.ubicacion);
    const clave = pasillo === null ? "OTRAS" : String(pasillo);
    if (!pasillos.has(clave)) pasillos.set(clave, { total: 0, completos: 0, bultos: 0, bultosCompletos: 0 });
    const item = pasillos.get(clave);
    item.total += 1;
    item.bultos += num(row.bultos);
    if (normalizar(row.estado) === "COMPLETO") {
      item.completos += 1;
      item.bultosCompletos += num(row.bultos);
    }
  });
  const pasillosOrdenados = Array.from(pasillos.entries()).sort(([a], [b]) => {
    if (a === "OTRAS") return 1;
    if (b === "OTRAS") return -1;
    return Number(a) - Number(b);
  });
  document.getElementById("resultado").innerHTML = `
    <article class="result-card reports-module work-dashboard-module">
      <section class="rf-report-sheet rf-mobile-report work-dashboard">
        <div class="rf-mobile-title green">
          <span>Trabajo RF</span>
          <h2>Dashboard de avance</h2>
        </div>
        <div class="rf-mobile-kpis work-dashboard-kpis">
          ${kpiMovil("total", "Tareas", fmt(total), `${fmt(bultosTotal)} bultos`)}
          ${kpiMovil("cumplimiento", "Completadas", fmt(completos.length), `${fmt(bultosCompletos)} bultos`)}
          ${kpiMovil("grafico", "Pendientes", fmt(pendientes), `${fmt(bultosPendientes)} bultos`)}
          ${kpiMovil("hora", "Avance", `${porcentaje.toFixed(1)}%`, "del dia")}
        </div>
        ${pastelMovil("Avance del dia", [
          { label: "Completadas", valor: bultosCompletos },
          { label: "Pendientes", valor: bultosPendientes }
        ], Math.max(bultosTotal, 1), `${porcentaje.toFixed(1)}%`)}
        <section class="rf-mobile-card work-dashboard-panel">
          <div class="rf-mobile-section-title"><h3>Avance por pasillo</h3><strong>${fmt(pasillosOrdenados.length)}</strong></div>
          <div class="work-dashboard-aisles">
            ${pasillosOrdenados.map(([clave, item]) => `
              <article>
                <div><strong>${clave === "OTRAS" ? "Otras" : `P${clave}`}</strong><span>${fmt(item.bultosCompletos)} / ${fmt(item.bultos)} bultos</span></div>
                <i><u style="width:${Math.min(100, pct(item.bultosCompletos, item.bultos))}%"></u></i>
              </article>
            `).join("") || `<div class="empty-mini">Sin avance registrado.</div>`}
          </div>
        </section>
      </section>
    </article>
  `;
}

function renderReportePicking() {
  const dataGeneral = modeloPickingReporte();
  const data = turnoReportePicking === "TODOS" ? dataGeneral : dataGeneral.filter(r => r.turno === turnoReportePicking);
  const total = data.reduce((acc, row) => acc + row.bultos, 0);
  const horas = horasPickingReporte(data);
  const horaPico = horas.slice().sort((a, b) => b.valor - a.valor)[0];
  const promedioHora = horas.length ? total / horas.length : 0;
  return `
    <section class="rf-report-sheet picking rf-mobile-picking rf-mobile-report" style="width:600px;max-width:100%;margin-inline:auto;">
      <div class="rf-mobile-title">
        <span>Modulo RF</span>
        <h2>Reporte de Picking</h2>
      </div>
      <label class="rf-mobile-filter">Turno
        <select onchange="cambiarTurnoReporte(this.value)">
          ${["TODOS", "DIA", "TARDE", "NOCHE"].map(t => `<option value="${t}" ${turnoReportePicking === t ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </label>
      <div class="rf-mobile-kpis">
        ${kpiMovil("total", "Total bultos pickados", fmt(total))}
        ${kpiMovil("hora", "Hora pico", htmlSeguro(horaPico?.label || "-"), `${fmt(horaPico?.valor || 0)} bultos`)}
        ${kpiMovil("promedio", "Promedio x hora", fmt(promedioHora), `${fmt(horas.length)} horas activas`)}
      </div>
      ${tendenciaPickingMovil(horas, total)}
      ${detalleUsuariosPickingMovil(data, total)}
    </section>
  `;
}

function renderTopPickingDashboard() {
  if (!datosListos) {
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a abrir Top Picking.");
    return;
  }
  if (!reportesCargados) {
    document.getElementById("resultado").innerHTML = `
      <article class="result-card reports-module">
        <div class="result-head"><span>Modulo RF</span><strong>Cargando Top Picking...</strong></div>
        <div class="empty-state"><strong>Preparando informacion</strong><span>Se esta cargando PICKING y USUARIO desde la data BI.</span></div>
      </article>
    `;
    cargarReportes().then(() => {
      if (vistaRf === "topPicking") renderTopPickingDashboard();
    });
    return;
  }
  const data = modeloPickingReporte();
  const total = data.reduce((acc, row) => acc + row.bultos, 0);
  const usuarios = usuariosPickingReporte(data);
  const top = usuarios.slice(0, 3);
  const restantes = usuarios.slice(3);
  const max = Math.max(...top.map(row => row.bultos), 1);
  const horas = horasPickingReporte(data);
  const horaPico = horas.slice().sort((a, b) => b.valor - a.valor)[0];
  document.getElementById("resultado").innerHTML = `
    <article class="result-card top-picking-module">
      <section class="top-picking-hero">
        <div>
          <span>Ranking RF</span>
          <h2>Top 3 Picking</h2>
        </div>
        <strong>${fmt(total)}<small>bultos</small></strong>
      </section>
      <section class="top-picking-kpis">
        ${kpiMovil("proveedor", "Usuarios", fmt(usuarios.length), "Con picking registrado")}
        ${kpiMovil("hora", "Hora pico", htmlSeguro(horaPico?.label || "-"), `${fmt(horaPico?.valor || 0)} bultos`)}
        ${kpiMovil("promedio", "Promedio x hora", fmt(horas.length ? total / horas.length : 0), `${fmt(horas.length)} horas activas`)}
      </section>
      <section class="top-picking-podium">
        ${top.map((usuario, index) => `
          <article class="rank-${index + 1}">
            <em>${index + 1}</em>
            <div class="top-avatar">${htmlSeguro((usuario.nombre || usuario.usuario || "U").slice(0, 1).toUpperCase())}</div>
            <div>
              <strong>${htmlSeguro(usuario.nombre)}</strong>
              <span>${htmlSeguro(usuario.usuario)}</span>
            </div>
            <b>${fmt(usuario.bultos)}<small>bultos</small></b>
            <i><u style="width:${pct(usuario.bultos, max)}%"></u></i>
          </article>
        `).join("") || `<div class="empty-mini">Sin usuarios para mostrar.</div>`}
      </section>
      <details class="rf-mobile-card top-picking-more" open>
        <summary>
          <span>Demas usuarios</span>
          <strong>${fmt(restantes.length)}</strong>
        </summary>
        <div class="top-picking-more-list">
          ${restantes.map((usuario, index) => `
            <article>
              <em>${index + 4}</em>
              <div>
                <strong>${htmlSeguro(usuario.nombre)}</strong>
                <span>${htmlSeguro(usuario.usuario)} | ${fmt(usuario.lpnsTotal)} LPNs</span>
              </div>
              <b>${fmt(usuario.bultos)}</b>
              <i><u style="width:${pct(usuario.bultos, max)}%"></u></i>
            </article>
          `).join("") || `<div class="empty-mini">Sin mas usuarios.</div>`}
        </div>
      </details>
      <section class="rf-mobile-card">
        <div class="rf-mobile-section-title">
          <h3>Bultos por hora</h3>
          <strong>${fmt(total)}</strong>
        </div>
        <div class="rf-hour-bars">
          ${horas.map(item => `
            <article class="${item === horaPico ? "peak" : ""}">
              <span>${htmlSeguro(item.label)}</span>
              <div><i style="width:${Math.max(4, pct(item.valor, horaPico?.valor || 1))}%"></i></div>
              <strong>${fmt(item.valor)}</strong>
            </article>
          `).join("")}
        </div>
      </section>
    </article>
  `;
}

function filtroProveedoresReporte(proveedores) {
  const visibles = proveedoresVisiblesReporte(proveedores);
  return `
    <details class="provider-filter-rf">
      <summary>Escoger proveedores <b>${fmt(visibles.length)}/${fmt(proveedores.length)}</b></summary>
      <div class="provider-actions-rf">
        <button onclick="setProveedoresReporte('todos')">Todos</button>
        <button onclick="setProveedoresReporte('ninguno')">Ninguno</button>
      </div>
      <div class="provider-checks-rf">
        ${proveedores.map(p => {
          const checked = proveedoresReporteSeleccionados === null || proveedoresReporteSeleccionados.has(p.key);
          return `
            <label>
              <input type="checkbox" data-key="${atributoSeguro(p.key)}" ${checked ? "checked" : ""} onchange="toggleProveedorReporte(this.dataset.key, this.checked)">
              <span>${htmlSeguro(corto(p.proveedor, 26))}</span>
              <b>${fmt(p.recibido)}</b>
            </label>
          `;
        }).join("")}
      </div>
    </details>
  `;
}

function renderReporteRecepcion() {
  const dataGeneral = modeloRecepcionReporte();
  const proveedores = proveedoresResumenReporte(dataGeneral);
  const visibles = proveedoresVisiblesReporte(proveedores);
  const claves = new Set(visibles.map(p => p.key));
  const dataVisible = dataGeneral.filter(row => claves.has(row.proveedorKey));
  const resumen = resumenRecepcionRf(dataVisible, visibles);
  return `
    <section class="rf-report-sheet reception rf-mobile-picking rf-mobile-report">
      <div class="rf-mobile-title green">
        <span>Modulo RF</span>
        <h2>Reporte de Recepcion</h2>
      </div>
      <div class="rf-mobile-kpis">
        ${kpiMovil("recibido", "Recibido", fmt(resumen.totalRecibido), "Bultos recibidos")}
        ${kpiMovil("total", "Programado", fmt(resumen.totalProgramado), "Bultos programados")}
        ${kpiMovil("cumplimiento", "Cumplimiento", `${resumen.cumplimiento.toFixed(1)}%`, `Dif. ${fmt(resumen.diferencia)}`)}
        ${kpiMovil("pallet", "Paleteros recibidos", fmt(resumen.paleterosRecibidos), "ASN OS917")}
        ${kpiMovil("proveedor", "Proveedores", fmt(resumen.proveedores), "Seleccionados")}
      </div>
      ${filtroProveedoresReporte(proveedores)}
      ${pastelMovil("Cumplimiento recepcion", [
        { label: "Recibido", valor: resumen.totalRecibido },
        { label: "Pendiente", valor: Math.max(0, resumen.totalProgramado - resumen.totalRecibido) }
      ], Math.max(resumen.totalProgramado, resumen.totalRecibido), `${resumen.cumplimiento.toFixed(1)}%`)}
      ${pastelMovil("Mix Punta Negra 917", [
        { label: "917 recibido", valor: resumen.recibido917 },
        { label: "Otros proveedores", valor: Math.max(0, resumen.totalRecibido - resumen.recibido917) }
      ], Math.max(resumen.totalRecibido, 1), "917")}
      ${indicadoresRecepcionMovil(resumen)}
      ${proveedoresRecepcionMovil(visibles, resumen.totalRecibido)}
    </section>
  `;
}

function renderReporteDespacho() {
  const dataGeneral = modeloDespachoReporte();
  const data = turnoReporteDespacho === "TODOS" ? dataGeneral : dataGeneral.filter(row => row.turno === turnoReporteDespacho);
  const resumen = resumenDespachoRf(data, turnoReporteDespacho);
  const resumenGeneral = resumenDespachoRf(dataGeneral, "TODOS");
  const viajesHora = viajesDespachoPorHoraRf(turnoReporteDespacho);
  const horaPico = viajesHora.slice().sort((a, b) => b.valor - a.valor)[0];
  return `
    <section class="rf-report-sheet dispatch rf-mobile-picking rf-mobile-report">
      <div class="rf-mobile-title amber">
        <span>Modulo RF</span>
        <h2>Reporte de Despacho</h2>
      </div>
      <label class="rf-mobile-filter">Turno
        <select onchange="cambiarTurnoDespachoRf(this.value)">
          ${["TODOS", "DIA", "NOCHE"].map(t => `<option value="${t}" ${turnoReporteDespacho === t ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </label>
      <div class="rf-mobile-kpis">
        ${kpiMovil("viaje", "Viajes", fmt(resumen.viajes), `Hora pico ${htmlSeguro(horaPico?.label || "-")} | ${fmt(horaPico?.valor || 0)} viajes`)}
        ${kpiMovil("pallet", "Pallets", fmt(resumen.palletsTotal), `${fmt(resumen.mono)} mono | ${fmt(resumen.multi)} multisku`)}
        ${kpiMovil("tienda", "Tiendas", fmt(resumen.tiendas), `${fmt(resumen.placas)} placas`)}
        ${kpiMovil("costo", "Costo", `S/ ${fmt(resumen.costoTotal)}`, "Valorizado despacho")}
        ${kpiMovil("grafico", "Bultos x pallet", fmt(resumen.bultosPallet), `${fmt(resumen.totalBultos)} bultos`)}
      </div>
      ${pastelMovil("Costo por turno", [
        { label: "Dia", valor: resumenDespachoRf(dataGeneral.filter(row => row.turno === "DIA"), "DIA").costoTotal },
        { label: "Noche", valor: resumenDespachoRf(dataGeneral.filter(row => row.turno === "NOCHE"), "NOCHE").costoTotal },
        { label: "Sin turno", valor: resumenDespachoRf(dataGeneral.filter(row => row.turno === "SIN TURNO"), "TODOS").costoTotal }
      ], Math.max(resumenGeneral.costoTotal, 1), "Costo")}
      ${pastelMovil("Tipo de pallet", [
        { label: "Monopallet", valor: resumen.mono },
        { label: "Multisku", valor: resumen.multi }
      ], Math.max(resumen.palletsTotal, 1), "Pallets")}
      ${viajesHora.length ? tendenciaPickingMovil(viajesHora, Math.max(resumen.viajes, 1), "Viajes despacho por hora", "Sin viajes horarios de despacho.") : ""}
      ${turnosDespachoMovil(dataGeneral, resumenGeneral)}
      <section class="rf-mobile-card">
        <div class="rf-mobile-section-title">
          <h3>Resumen logistico</h3>
          <strong>${fmt(resumen.viajes)}</strong>
        </div>
        <div class="rf-mobile-summary-grid">
          <article><span>Capacidad</span><strong>${fmt(resumen.capacidadTotal)}</strong></article>
          <article><span>Ocupacion</span><strong>${resumen.ocupacion.toFixed(1)}%</strong></article>
          <article><span>Unidades</span><strong>${fmt(resumen.totalUnidades)}</strong></article>
          <article><span>Bultos</span><strong>${fmt(resumen.totalBultos)}</strong></article>
        </div>
      </section>
      ${cargasDespachoMovil(data)}
    </section>
  `;
}

function renderReportes() {
  if (!datosListos) {
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a abrir reportes.");
    return;
  }
  if (!reportesCargados) {
    document.getElementById("resultado").innerHTML = `
      <article class="result-card reports-module">
        <div class="result-head"><span>Modulo RF</span><strong>Cargando reportes...</strong></div>
        <div class="empty-state"><strong>Preparando informacion</strong><span>Los reportes se cargan solo al entrar a este modulo.</span></div>
      </article>
    `;
    cargarReportes().then(() => {
      if (vistaRf === "reportes") renderReportes();
    });
    return;
  }
  document.getElementById("resultado").innerHTML = `
    <article class="result-card reports-module">
      <div class="result-head">
        <span>Modulo RF</span>
        <strong>Reportes</strong>
      </div>
      <div class="report-tabs">
        <button class="${reporteActivo === "picking" ? "active" : ""}" onclick="cambiarReporte('picking')">Picking</button>
        <button class="${reporteActivo === "recepcion" ? "active" : ""}" onclick="cambiarReporte('recepcion')">Recepcion</button>
        <button class="${reporteActivo === "despacho" ? "active" : ""}" onclick="cambiarReporte('despacho')">Despacho</button>
      </div>
      <div class="report-scroll">
        ${reporteActivo === "picking" ? renderReportePicking() : reporteActivo === "recepcion" ? renderReporteRecepcion() : renderReporteDespacho()}
      </div>
    </article>
  `;
}

function verDetalleValidacionRf(index) {
  const row = obtenerValidacionPlusRf()[Number(index)];
  if (!row) return;
  document.getElementById("resultado").innerHTML = `
    <article class="result-card validation-screen">
      <div class="result-head">
        <span>${htmlSeguro(row.origen)} | ${htmlSeguro(row.ubicacionOrigen || "-")}</span>
        <strong>${htmlSeguro(row.codigo)}</strong>
      </div>
      <div class="product-list">
        <button type="button" class="back-button" id="volverValidacion">Volver</button>
        <section class="selected-product">
          <div class="decision-pill ${row.clase}">
            <strong>${htmlSeguro(row.texto)}</strong>
            <span>Plus primero: ${fmt(row.codPlus)} | Pedido fila: ${fmt(row.pedido)} | Sobrante real: ${fmt(row.sobranteReal)}</span>
          </div>
          <div class="selected-title">
            <h3>${htmlSeguro(row.codigo)}${row.codigoAlt ? ` | ${htmlSeguro(row.codigoAlt)}` : ""}</h3>
            <p>${htmlSeguro(row.descripcion || "Sin descripcion")}</p>
          </div>
          <div class="product-metrics">
            <b>${fmt(row.pedidoOriginal)}<small>Pedido original</small></b>
            <b>${fmt(row.activo)}<small>Activo</small></b>
            <b>${fmt(row.pedido)}<small>Fila</small></b>
          </div>
          <div class="product-metrics">
            <b>${fmt(row.codPlus)}<small>Plus</small></b>
            <b>${fmt(row.difFila)}<small>Diferencia fila</small></b>
            <b>${fmt(row.sobranteReal)}<small>Sobrante real</small></b>
          </div>
          <div class="dest-grid full">
            <section>
              <h4>LPNs en Plus</h4>
              ${row.lpnsCodPlus.length ? row.lpnsCodPlus.map(lpn => `
                <div class="dest-row ok">
                  <div>
                    <strong>${htmlSeguro(lpn.lpn)}</strong>
                    <span>${htmlSeguro(lpn.ubicacion)} | ${htmlSeguro(lpn.estado)}</span>
                  </div>
                  <b>${fmt(lpn.bultos)}</b>
                  <small>bultos</small>
                </div>
              `).join("") : `<div class="empty-mini bad">Sin LPNs en DROP-COD-PLUS-ALM.</div>`}
            </section>
          </div>
        </section>
      </div>
    </article>
  `;
}

function cambiarVistaRf(vista) {
  if (!usuarioTieneVista(vista)) vista = vistaInicialUsuario();
  vistaRf = vista;
  actualizarTituloModuloRf();
  if (vista !== "trabajo") detenerSincronizacionTrabajo();
  document.getElementById("appView")?.classList.toggle("report-mode", vista === "reportes" || vista === "topPicking");
  const vistaAsignacionGrupo = ["asignacion", "validacion", "trabajo", "dashboard"].includes(vista);
  document.getElementById("tabConsulta").classList.toggle("active", vista === "consulta");
  document.getElementById("tabValidacion").classList.toggle("active", vista === "validacion");
  document.getElementById("tabAsignacion").classList.toggle("active", vista === "asignacion");
  document.getElementById("tabTrabajo").classList.toggle("active", vista === "trabajo");
  document.getElementById("tabDashboard").classList.toggle("active", vista === "dashboard");
  document.getElementById("menuAsignacion").classList.toggle("active", vistaAsignacionGrupo);
  document.getElementById("tabTopPicking").classList.toggle("active", vista === "topPicking");
  document.getElementById("tabReportes").classList.toggle("active", vista === "reportes");
  document.querySelector(".scan-panel").hidden = vista !== "consulta";
  if (vista === "validacion") {
    detenerCamara();
    renderValidacionPlusMovil();
  } else if (vista === "asignacion") {
    detenerCamara();
    renderAsignacionOperacionalMovil();
  } else if (vista === "trabajo") {
    detenerCamara();
    renderTrabajoAsignacionMovil();
  } else if (vista === "dashboard") {
    detenerCamara();
    renderDashboardTrabajo();
  } else if (vista === "topPicking") {
    detenerCamara();
    renderTopPickingDashboard();
  } else if (vista === "reportes") {
    detenerCamara();
    renderReportes();
  } else {
    mostrarMensaje("Listo para consulta", "Escanea un codigo de barras de LPN.");
    enfocarLpn();
  }
}

function renderActivoConsulta(activos) {
  if (!activos.length) return `<div class="empty-mini bad">Sin ubicacion activa para este codigo.</div>`;
  return activos.map(row => `
    <div class="dest-row">
      <div>
        <strong>${htmlSeguro(row.ubicacion)}</strong>
        <span>Stock ${fmt(row.bultos)} bul | Asig ${fmt(row.uniAsig)} | Tran ${fmt(row.transito)}</span>
      </div>
      <b>${fmtDisp(row.disponibleBultos, row.capacidadDinamica)}</b>
      <small>disponible bul</small>
    </div>
  `).join("");
}

function renderLpnsProducto(lpns) {
  if (!lpns.length) return `<div class="empty-mini warn">No hay LPNs con este codigo en la data LPNS.</div>`;
  return lpns.map(row => `
    <div class="dest-row ${normalizar(row.ubicacion).startsWith("MASS-") ? "ok" : "warn"}">
      <div>
        <strong>${htmlSeguro(row.lpn)}</strong>
        <span>${htmlSeguro(row.ubicacion)} | ${htmlSeguro(row.estado)}</span>
      </div>
      <b>${fmt(row.bultos)}</b>
      <small>bultos</small>
    </div>
  `).join("");
}

function renderProductoConsulta(productoBase) {
  const lpns = lpnsProducto(productoBase);
  const producto = {
    ...productoBase,
    bultos: lpns.reduce((a, b) => a + b.bultos, 0),
    unidades: lpns.reduce((a, b) => a + b.unidades, 0),
    lineas: lpns.length
  };
  const activos = activoProducto(producto);
  const reservas = reservaProducto(producto, "");
  lpnActualRows = [];
  productosActuales = [producto];
  codigoSeleccionado = producto.codigo;

  document.getElementById("resultado").innerHTML = `
    <article class="result-card">
      <div class="result-head">
        <span>Codigo producto</span>
        <strong>${htmlSeguro(producto.codigo)}</strong>
      </div>
      <div class="kpi-grid">
        <div class="mini-kpi">
          <span>Cod alterno</span>
          <strong>${htmlSeguro(producto.codigoAlt || "-")}</strong>
        </div>
        <div class="mini-kpi">
          <span>Estilo</span>
          <strong>${htmlSeguro(producto.estilo || "-")}</strong>
        </div>
        <div class="mini-kpi">
          <span>LPNs</span>
          <strong>${fmt(lpns.length)}</strong>
        </div>
        <div class="mini-kpi">
          <span>Activo</span>
          <strong>${fmt(activos.length)}</strong>
        </div>
      </div>
      <div class="product-list">
        <section class="selected-product">
          <div class="selected-title">
            <h3>${htmlSeguro(producto.codigo)}${producto.codigoAlt ? ` | ${htmlSeguro(producto.codigoAlt)}` : ""}</h3>
            <p>${producto.estilo ? `Estilo ${htmlSeguro(producto.estilo)} | ` : ""}${htmlSeguro(producto.descripcion || "Sin descripcion")}</p>
          </div>
          <div class="dest-grid full">
            <section>
              <h4>Activo</h4>
              ${renderActivoConsulta(activos)}
            </section>
            <section>
              <h4>Reserva MASS</h4>
              ${renderReservaMovil(reservas)}
            </section>
            <section>
              <h4>LPNs con el codigo</h4>
              ${renderLpnsProducto(lpns)}
            </section>
          </div>
        </section>
      </div>
    </article>
  `;
}

function renderProductosSelector(productos) {
  return `
    <section class="product-selector">
      <div class="selector-head">
        <strong>Productos del LPN</strong>
        <span>${fmt(productos.length)} codigos</span>
      </div>
      <div class="product-table-list">
        ${productos.map((producto, index) => {
          const activos = activoProducto(producto);
          const reservas = reservaProducto(producto, lpnActualRows[0]?.lpn || "");
          const decision = resumenDecision(producto, activos, reservas);
          const activo = producto.codigo === codigoSeleccionado ? "active" : "";
          return `
            <button type="button" class="product-item ${activo}" data-codigo="${atributoSeguro(producto.codigo)}">
              <span class="product-index">${index + 1}</span>
              <span class="product-main">
                <b>${htmlSeguro(producto.codigo)}${producto.codigoAlt ? ` | ${htmlSeguro(producto.codigoAlt)}` : ""}</b>
                <small>${htmlSeguro(producto.descripcion || "Sin descripcion")}</small>
              </span>
              <span class="product-count">
                <b>${fmt(producto.bultos)}</b>
                <small>BUL</small>
              </span>
              <span class="product-status ${decision.clase}">${htmlSeguro(decision.titulo)}</span>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderProductoSeleccionado() {
  const producto = productosActuales.find(row => row.codigo === codigoSeleccionado) || productosActuales[0];
  if (!producto) return "";
  const activos = activoProducto(producto);
  const reservas = reservaProducto(producto, lpnActualRows[0]?.lpn || "");
  const decision = resumenDecision(producto, activos, reservas);
  return `
    <section class="selected-product">
      <div class="decision-pill ${decision.clase}">
        <strong>${htmlSeguro(decision.titulo)}</strong>
        <span>${htmlSeguro(decision.detalle)}</span>
      </div>
      <div class="selected-title">
        <h3>${htmlSeguro(producto.codigo)}${producto.codigoAlt ? ` | ${htmlSeguro(producto.codigoAlt)}` : ""}</h3>
        <p>${htmlSeguro(producto.descripcion || "Sin descripcion")}</p>
      </div>
      <div class="product-metrics">
        <b>${fmt(producto.bultos)}<small>Bultos</small></b>
        <b>${fmt(producto.unidades)}<small>Unidades</small></b>
        <b>${fmt(producto.lineas)}<small>Lineas</small></b>
      </div>
      <div class="dest-grid full">
        <section>
          <h4>Activo</h4>
          ${renderActivoMovil(activos)}
        </section>
        <section>
          <h4>Reserva / seteo</h4>
          ${renderReservaMovil(reservas)}
        </section>
      </div>
    </section>
  `;
}

function seleccionarProductoRf(codigo) {
  codigoSeleccionado = normalizar(codigo);
  const detalle = document.getElementById("productoDetalleRf");
  const lista = document.getElementById("productosSelectorRf");
  if (lista) lista.innerHTML = renderProductosSelector(productosActuales);
  if (detalle) detalle.innerHTML = renderProductoSeleccionado();
}

function atributoSeguro(valor) {
  return htmlSeguro(valor).replace(/`/g, "&#096;");
}

function manejarClickResultado(event) {
  const asignacion = event.target.closest("[data-assignment-key]");
  if (asignacion) {
    toggleAsignacionOperativa(asignacion.dataset.assignmentKey || "");
    return;
  }
  const validacion = event.target.closest(".validation-item");
  if (validacion) {
    verDetalleValidacionRf(validacion.dataset.index);
    return;
  }
  if (event.target.closest("#volverValidacion")) {
    renderValidacionPlusMovil();
    return;
  }
  const boton = event.target.closest(".product-item");
  if (!boton) return;
  const codigo = boton.dataset.codigo || "";
  if (!codigo) return;
  seleccionarProductoRf(codigo);
}

function argumentoSeguro(valor) {
  return JSON.stringify(limpiar(valor)).replace(/</g, "\\u003c");
}

function renderLpn(rows) {
  const first = rows[0];
  const totalBultos = rows.reduce((a, b) => a + b.bultos, 0);
  const totalUnidades = rows.reduce((a, b) => a + b.unidades, 0);
  const productos = consolidarProductosLpn(rows);
  lpnActualRows = rows;
  productosActuales = productos;
  codigoSeleccionado = productos[0]?.codigo || "";
  const codigos = productos.length;
  const ubicacion = first.ubicacion || "SIN UBICACION";
  const estadoLpn = first.estado || "SIN ESTADO";
  const tono = tonoEstado(estadoLpn, ubicacion);

  document.getElementById("resultado").innerHTML = `
    <article class="result-card">
      <div class="result-head">
        <span>LPN</span>
        <strong>${htmlSeguro(first.lpn)}</strong>
      </div>
      <div class="kpi-grid">
        <div class="mini-kpi ${tono}">
          <span>Ubicacion</span>
          <strong>${htmlSeguro(ubicacion)}</strong>
        </div>
        <div class="mini-kpi ${tono}">
          <span>Estado</span>
          <strong>${htmlSeguro(estadoLpn)}</strong>
        </div>
        <div class="mini-kpi">
          <span>Bultos</span>
          <strong>${fmt(totalBultos)}</strong>
        </div>
        <div class="mini-kpi">
          <span>Codigos</span>
          <strong>${fmt(codigos)}</strong>
        </div>
      </div>
      <div class="product-list">
        <div id="productosSelectorRf">${renderProductosSelector(productos)}</div>
        <div id="productoDetalleRf">${renderProductoSeleccionado()}</div>
        <div class="product-row">
          <h3>Total</h3>
          <div class="product-metrics">
            <b>${fmt(totalBultos)}<small>Bultos</small></b>
            <b>${fmt(totalUnidades)}<small>Unidades</small></b>
            <b>${fmt(rows.length)}<small>Lineas</small></b>
          </div>
        </div>
      </div>
    </article>
  `;
}

function mostrarMensaje(titulo, detalle = "", alerta = false) {
  document.getElementById("resultado").innerHTML = `
    <div class="empty-state ${alerta ? "not-found" : ""}">
      <strong>${htmlSeguro(titulo)}</strong>
      <span>${htmlSeguro(detalle)}</span>
    </div>
  `;
}

async function alternarCamara() {
  if (scannerActivo) return detenerCamara();
  await iniciarCamara();
}

async function iniciarCamara() {
  const estadoScanner = document.getElementById("scannerEstado");
  if (!("BarcodeDetector" in window)) {
    estadoScanner.textContent = "Este navegador no soporta lectura por camara. Usa pistola RF o digita el LPN.";
    return;
  }
  try {
    scannerDetector = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "qr_code"] });
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    const video = document.getElementById("scannerVideo");
    video.srcObject = scannerStream;
    await video.play();
    document.getElementById("cameraBox").hidden = false;
    document.getElementById("cameraButton").textContent = "Cerrar";
    estadoScanner.textContent = "Apunta al codigo de barras del LPN.";
    scannerActivo = true;
    detectarLoop();
  } catch (error) {
    estadoScanner.textContent = "No se pudo abrir la camara. Usa pistola RF o digita el LPN.";
  }
}

async function detectarLoop() {
  if (!scannerActivo || !scannerDetector) return;
  const video = document.getElementById("scannerVideo");
  try {
    const codes = await scannerDetector.detect(video);
    const valor = codes[0]?.rawValue || "";
    if (valor) {
      buscarConsulta(valor);
      detenerCamara();
      return;
    }
  } catch (error) {}
  requestAnimationFrame(detectarLoop);
}

function detenerCamara() {
  scannerActivo = false;
  if (scannerStream) {
    scannerStream.getTracks().forEach(track => track.stop());
    scannerStream = null;
  }
  document.getElementById("cameraBox").hidden = true;
  document.getElementById("cameraButton").textContent = "Camara";
  document.getElementById("scannerEstado").textContent = "Puedes usar pistola RF o escribir el LPN.";
  enfocarLpn();
}

document.getElementById("loginForm").addEventListener("submit", validarLogin);
document.getElementById("scanForm").addEventListener("submit", buscarManual);
document.getElementById("lpnInput").addEventListener("input", programarSugerenciasBusqueda);
document.getElementById("lpnInput").addEventListener("blur", () => setTimeout(ocultarSugerencias, 180));
document.getElementById("sugerenciasBusqueda").addEventListener("pointerdown", manejarClickSugerencia);
document.getElementById("sugerenciasBusqueda").addEventListener("click", manejarClickSugerencia);
document.getElementById("refreshButton").addEventListener("click", () => recargarDatos(true));
document.getElementById("headerRefreshButton").addEventListener("click", () => recargarDatos(true));
document.getElementById("logoutButton").addEventListener("click", salir);
document.getElementById("cameraButton").addEventListener("click", alternarCamara);
document.getElementById("resultado").addEventListener("click", manejarClickResultado);
document.getElementById("tabConsulta").addEventListener("click", () => cambiarVistaRf("consulta"));
document.getElementById("tabValidacion").addEventListener("click", () => cambiarVistaRf("validacion"));
document.getElementById("tabAsignacion").addEventListener("click", () => cambiarVistaRf("asignacion"));
document.getElementById("tabTrabajo").addEventListener("click", () => cambiarVistaRf("trabajo"));
document.getElementById("tabDashboard").addEventListener("click", () => cambiarVistaRf("dashboard"));
document.getElementById("tabTopPicking").addEventListener("click", () => cambiarVistaRf("topPicking"));
document.getElementById("tabReportes").addEventListener("click", () => cambiarVistaRf("reportes"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) detenerCamara();
});

mostrarLogin();
