const RF_USER = "SCANER";
const RF_PASS = "1234";
const CAPACIDAD_DINAMICA_UND = 999999;

let scannerStream = null;
let scannerDetector = null;
let scannerActivo = false;
let lpnActualRows = [];
let productosActuales = [];
let codigoSeleccionado = "";
let timerSugerencias = null;
let vistaRf = "consulta";
let cacheValidacionPlus = null;
let reporteActivo = "picking";
let turnoReportePicking = "TODOS";
let proveedoresReporteSeleccionados = null;

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
  const iso = texto.replace(" ", "T");
  const fecha = new Date(iso);
  if (!Number.isNaN(fecha.getTime())) return fecha;
  const partes = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!partes) return null;
  return new Date(Number(partes[3]), Number(partes[2]) - 1, Number(partes[1]), Number(partes[4] || 0), Number(partes[5] || 0));
}

function horaFecha(fecha) {
  return fecha ? fecha.getHours() : null;
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
  const tipo = normalizar(row.tipo).replace(/[^A-Z0-9]/g, "");
  if (tipo === "FULLCONTAINER") return false;
  if (normalizar(row.lpn).startsWith("ILE")) return false;
  if (descripcionNoCuentaReporte(row.descripcion)) return false;
  return true;
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
    const horaRaw = campo(r, ["HORA RECEPCION", "HORA", "Hora"]);
    const hora = horaRaw !== "" ? Math.trunc(num(horaRaw)) : horaFecha(fecha);
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
  recargarDatos(false);
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
  if (user !== RF_USER || pass !== RF_PASS) {
    document.getElementById("loginError").textContent = "Usuario o contrasena incorrecta.";
    document.getElementById("password").select();
    return;
  }
  document.getElementById("loginError").textContent = "";
  mostrarApp();
}

function salir() {
  detenerCamara();
  document.getElementById("password").value = "";
  mostrarLogin();
}

async function recargarDatos(forzar = true) {
  if (datosListos && !forzar) {
    estado(`${fmt(dataLPN.length)} LPNs | data lista`);
    if (vistaRf === "validacion") renderValidacionPlusMovil();
    else if (vistaRf === "reportes") renderReportes();
    else enfocarLpn();
    return;
  }
  const boton = document.getElementById("refreshButton");
  if (boton) {
    boton.disabled = true;
    boton.textContent = "Leyendo...";
  }
  try {
    await cargarDatos();
    cacheValidacionPlus = null;
    if (vistaRf === "validacion") renderValidacionPlusMovil();
    else if (vistaRf === "reportes") renderReportes();
    else enfocarLpn();
  } catch (error) {
    estado("Error al cargar data");
    mostrarMensaje("No se pudo cargar LPNS", error.message || String(error), true);
  } finally {
    if (boton) {
      boton.disabled = false;
      boton.textContent = "Actualizar data";
    }
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
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a escanear.");
    return;
  }

  const rows = dataLPN.filter(row => normalizar(row.lpn) === q);
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
  const producto = dataProductos.find(row =>
    row.codigo === exacto ||
    normalizar(row.codigoAlt) === exacto ||
    normalizar(row.estilo) === exacto
  ) || dataProductos.find(row => normalizar(row.estilo).includes(exacto) && exacto.length >= 3);
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

function activoProducto(producto) {
  const agrupado = new Map();
  dataInventario
    .filter(row => row.codigo === producto.codigo && row.ubicacion)
    .forEach(row => {
      const key = row.ubicacion;
      if (!agrupado.has(key)) {
        agrupado.set(key, {
          ubicacion: row.ubicacion,
          codigo: row.codigo,
          unidades: 0,
          bultos: 0,
          uniAsig: 0,
          transito: 0,
          uniMax: 0,
          uxb: row.uxb || producto.uxb || 1
        });
      }
      const item = agrupado.get(key);
      item.unidades += row.unact;
      item.bultos += row.bultos;
      item.uniAsig += row.uniAsig;
      item.transito += row.transito;
      item.uniMax = Math.max(item.uniMax, row.uniMax);
      item.uxb = row.uxb || item.uxb || 1;
    });

  return Array.from(agrupado.values()).map(row => {
    const disp = disponibilidadPorCapacidad(row.uniMax, row.unidades, row.transito, row.uxb);
    const faltaUnd = disp.dinamica ? 0 : Math.max(0, producto.unidades - disp.disponibleUnd);
    const faltaBul = disp.dinamica ? 0 : Math.max(0, producto.bultos - disp.disponibleBul);
    return {
      ...row,
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
    "Codigo alternativo"
  ]));
}

function descripcionPedido(row) {
  return limpiar(campoPedido(row, ["DESCRIPCION", "Descripcion", "Descripción", "DESCRIPCION_PRODUCTO"]));
}

function bultosNoAsignadoPedido(row) {
  return num(campoPedido(row, ["BULTOS_NO_ASIGNADO", "BULTO_NO_ASIGANDO", "BULTOS_NO_ASIGANDO"]));
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
  return dataLPN.filter(row =>
    normalizar(row.codigo) === codigo &&
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

function renderReportePicking() {
  const dataGeneral = modeloPickingReporte();
  const data = turnoReportePicking === "TODOS" ? dataGeneral : dataGeneral.filter(r => r.turno === turnoReportePicking);
  const total = data.reduce((acc, row) => acc + row.bultos, 0);
  const totalGeneral = dataGeneral.reduce((acc, row) => acc + row.bultos, 0);
  const usuarios = new Set(data.map(r => r.usuario).filter(Boolean)).size;
  const lpns = new Set(data.map(r => r.lpn).filter(Boolean)).size;
  const horas = agruparSuma(data, r => r.hora === null || r.hora === undefined ? "S/H" : `${String(r.hora).padStart(2, "0")}:00`, r => r.bultos)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), "es", { numeric: true }));
  const topUsuario = agruparSuma(data, r => r.usuario, r => r.bultos)[0];
  const horaPico = horas.slice().sort((a, b) => b.valor - a.valor)[0];
  return `
    <section class="rf-report-sheet picking">
      <div class="rotate-hint">Gira el celular para ver el reporte horizontal completo.</div>
      <div class="rf-report-hero">
        <div><span>Reporte Picking</span><h2>${htmlSeguro(turnoReportePicking)}</h2></div>
        <article><span>Total picking</span><strong>${fmt(total)}</strong></article>
        <article><span>Usuarios</span><strong>${fmt(usuarios)}</strong></article>
        <article><span>LPNs</span><strong>${fmt(lpns)}</strong></article>
        <article><span>Prom. hora</span><strong>${fmt(horas.length ? total / horas.length : 0)}</strong></article>
      </div>
      <div class="rf-report-controls">
        ${["TODOS", "DIA", "TARDE", "NOCHE"].map(t => `<button class="${turnoReportePicking === t ? "active" : ""}" onclick="cambiarTurnoReporte('${t}')">${t}</button>`).join("")}
      </div>
      <div class="rf-report-highlights">
        <article><span>Top usuario</span><strong>${htmlSeguro(corto(topUsuario?.label || "-", 18))}</strong><small>${fmt(topUsuario?.valor || 0)} bultos</small></article>
        <article><span>Hora pico</span><strong>${htmlSeguro(horaPico?.label || "-")}</strong><small>${fmt(horaPico?.valor || 0)} bultos</small></article>
        <article><span>Participacion</span><strong>${pct(total, totalGeneral).toFixed(1)}%</strong><small>del picking general</small></article>
      </div>
      <div class="rf-report-grid">
        ${reporteLineal(`Tendencia picking - ${turnoReportePicking}`, horas, total, "#5a2db3")}
        ${reporteBarras("Bultos por hora", horas, total)}
        ${reporteRankingUsuarios(data, total)}
      </div>
    </section>
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
  const data = modeloRecepcionReporte();
  const proveedores = proveedoresResumenReporte(data);
  const visibles = proveedoresVisiblesReporte(proveedores);
  const claves = new Set(visibles.map(p => p.key));
  const dataVisible = data.filter(row => claves.has(row.proveedorKey));
  const totalRecibido = visibles.reduce((acc, p) => acc + p.recibido, 0);
  const totalProgramado = visibles.reduce((acc, p) => acc + p.programado, 0);
  const diferencia = totalProgramado - totalRecibido;
  const paleteros = new Set(dataVisible.map(r => r.asn).filter(asn => normalizar(asn).startsWith("OS917")).map(normalizar)).size;
  const pallets = new Set(dataVisible.map(r => r.lpn).filter(Boolean)).size;
  const top = visibles.slice(0, 10);
  return `
    <section class="rf-report-sheet reception">
      <div class="rotate-hint">Gira el celular para ver el reporte horizontal completo.</div>
      <div class="rf-report-hero green">
        <div><span>Reporte Recepcion</span><h2>Proveedores</h2></div>
        <article><span>Recibido</span><strong>${fmt(totalRecibido)}</strong></article>
        <article><span>Programado</span><strong>${fmt(totalProgramado)}</strong></article>
        <article><span>Diferencia</span><strong>${fmt(diferencia)}</strong></article>
        <article><span>Cumplimiento</span><strong>${pctCumplimiento(totalRecibido, totalProgramado).toFixed(1)}%</strong></article>
      </div>
      <div class="rf-report-highlights">
        <article><span>Proveedores</span><strong>${fmt(visibles.length)}</strong><small>seleccionados</small></article>
        <article><span>Paleteros</span><strong>${fmt(paleteros)}</strong><small>ASN OS917 unicos</small></article>
        <article><span>Pallets</span><strong>${fmt(pallets)}</strong><small>LPN/pallet recepcionados</small></article>
      </div>
      ${filtroProveedoresReporte(proveedores)}
      <div class="rf-report-grid reception-grid">
        ${reporteDonutRecepcion(totalRecibido, diferencia, paleteros, visibles.length)}
        <section class="rf-report-panel rf-provider-list">
          <header><h3>PROVEEDORES</h3><strong>${fmt(visibles.length)}</strong></header>
          ${top.map(p => `
            <article class="${p.diferencia === 0 ? "ok" : p.diferencia > 0 ? "warn" : "bad"}">
              <div><b>${htmlSeguro(corto(p.proveedor, 28))}</b><small>${htmlSeguro(p.codigo)} | ASN ${fmt(p.asnUnicos)} | Pallets ${fmt(p.palletsTotal)}</small></div>
              <strong>${fmt(p.recibido)}</strong>
              <span>${p.cumplimiento.toFixed(1)}% | Dif. ${fmt(p.diferencia)}</span>
            </article>
          `).join("") || `<div class="empty-mini">Sin proveedores seleccionados.</div>`}
        </section>
      </div>
    </section>
  `;
}

function renderReportes() {
  if (!datosListos) {
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a abrir reportes.");
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
      </div>
      <div class="report-scroll">
        ${reporteActivo === "picking" ? renderReportePicking() : renderReporteRecepcion()}
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
  vistaRf = vista;
  document.getElementById("appView")?.classList.toggle("report-mode", vista === "reportes");
  document.getElementById("tabConsulta").classList.toggle("active", vista === "consulta");
  document.getElementById("tabValidacion").classList.toggle("active", vista === "validacion");
  document.getElementById("tabReportes").classList.toggle("active", vista === "reportes");
  document.querySelector(".scan-panel").hidden = vista !== "consulta";
  if (vista === "validacion") {
    detenerCamara();
    renderValidacionPlusMovil();
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
document.getElementById("sugerenciasBusqueda").addEventListener("click", manejarClickSugerencia);
document.getElementById("refreshButton").addEventListener("click", () => recargarDatos(true));
document.getElementById("logoutButton").addEventListener("click", salir);
document.getElementById("cameraButton").addEventListener("click", alternarCamara);
document.getElementById("resultado").addEventListener("click", manejarClickResultado);
document.getElementById("tabConsulta").addEventListener("click", () => cambiarVistaRf("consulta"));
document.getElementById("tabValidacion").addEventListener("click", () => cambiarVistaRf("validacion"));
document.getElementById("tabReportes").addEventListener("click", () => cambiarVistaRf("reportes"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) detenerCamara();
});

mostrarLogin();
