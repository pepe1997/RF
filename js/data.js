const SHEET_ID = "1-v6vXjHpLlIn0-_lVZw0BtGopnxSHH0zqoOrW8aBwcg";
const TRABAJO_SHEET_ID = "1GY4EfroTQYqidPML5xj4qShkInKEnjWwJ7zSFGJEWsE";
const BI_SHEET_ID = "1fMEnjNjCZf0c-9VPmeHOQnFERXy5jz7XJ2lY64tblRc";
const RECEPCION_PROVEEDORES_SHEET_ID = "18iiFahjssG-2Or8HE9KjBer3DcuG0mDaMpxZj-rqycI";

let dataLPN = [];
let dataPedido = [];
let dataProductos = [];
let dataInventario = [];
let dataUbicaciones = [];
let dataBloqueo = [];
let dataPickingReporte = [];
let dataRecepcionReporte = [];
let dataRecepcionProveedoresResumen = [];
let dataCargaReporte = [];
let dataCartonesReporte = [];
let dataProductosReporte = [];
let dataUsuariosReporte = [];
let datosListos = false;
let datosOperativosListos = false;
let cargandoDatosOperativos = null;
let reportesCargados = false;
let cargandoReportes = null;
let indiceLpn = new Map();
let indiceLpnCodigo = new Map();
let indiceProducto = new Map();
let fallosCarga = new Set();
let generacionCargaRf = 0;
const TIEMPO_MAXIMO_FETCH_MS = 20000;

function limpiar(valor) {
  if (valor === null || valor === undefined) return "";
  return String(valor).trim();
}

function normalizar(valor) {
  return limpiar(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function num(valor) {
  const limpio = String(valor || "").trim().replace(/\s/g, "");
  const normal = limpio.includes(",") && limpio.includes(".")
    ? limpio.replace(/,/g, "")
    : limpio.replace(",", ".");
  const n = parseFloat(normal);
  return Number.isFinite(n) ? n : 0;
}

function fmt(valor) {
  return Number(valor || 0).toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

function campo(row, nombres) {
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

async function cargarHoja(nombre) {
  const errores = [];
  const url = `https://opensheet.elk.sh/${SHEET_ID}/${encodeURIComponent(nombre)}`;
  try {
    const res = await fetchConTiempo(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
    return await res.json();
  } catch (error) {
    errores.push(`OpenSheet: ${error.message || error}`);
  }

  try {
    return await cargarHojaCsv(SHEET_ID, nombre);
  } catch (error) {
    errores.push(`Google CSV: ${error.message || error}`);
  }

  throw new Error(`No se pudo cargar ${nombre}. ${errores.join(" | ")}`);
}

async function cargarHojaDesde(sheetId, nombre) {
  const errores = [];
  const url = `https://opensheet.elk.sh/${sheetId}/${encodeURIComponent(nombre)}`;
  try {
    const res = await fetchConTiempo(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
    return await res.json();
  } catch (error) {
    errores.push(`OpenSheet: ${error.message || error}`);
  }

  try {
    return await cargarHojaCsv(sheetId, nombre);
  } catch (error) {
    errores.push(`Google CSV: ${error.message || error}`);
  }

  throw new Error(`No se pudo cargar ${nombre}. ${errores.join(" | ")}`);
}

function detectarSeparadorCsv(texto) {
  const primera = String(texto || "").split(/\r?\n/)[0] || "";
  return (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ";" : ",";
}

function parseCsv(texto, separador = ",") {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < texto.length; i += 1) {
    const char = texto[i];
    const next = texto[i + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === separador && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(value);
      if (row.some(c => c !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some(c => c !== "")) rows.push(row);
  return rows;
}

function csvAObjetos(csv) {
  const rows = parseCsv(csv, detectarSeparadorCsv(csv));
  const headers = (rows.shift() || []).map(h => h.trim());
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    return obj;
  });
}

async function cargarHojaCsv(sheetId, nombre) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(nombre)}`;
  const res = await fetchConTiempo(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
  const csv = await res.text();
  const data = csvAObjetos(csv);
  if (!data.length) throw new Error("CSV sin filas");
  return data;
}

async function fetchConTiempo(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIEMPO_MAXIMO_FETCH_MS);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cargarOpcional(nombre) {
  try {
    return await cargarHoja(nombre);
  } catch (error) {
    fallosCarga.add(nombre);
    console.warn(`No se pudo cargar ${nombre}:`, error.message || error);
    return [];
  }
}

async function cargarOpcionalDesde(sheetId, nombre) {
  try {
    return await cargarHojaDesde(sheetId, nombre);
  } catch (error) {
    fallosCarga.add(`${sheetId}:${nombre}`);
    console.warn(`No se pudo cargar ${nombre}:`, error.message || error);
    return [];
  }
}

function cantidad(valor) {
  const texto = limpiar(valor);
  if (!texto) return 0;
  return num(texto);
}

function cantidadLpn(valor) {
  const texto = limpiar(valor);
  if (!texto) return 0;
  const limpio = texto.replace(/\s/g, "");
  if (/^-?\d{1,3}([.,])\d{3}$/.test(limpio)) return num(limpio.replace(/[.,]/g, ""));
  if (/^-?\d{1,3}([.,]\d{3})+([.,]\d+)?$/.test(limpio)) {
    const decimal = limpio.match(/[.,](\d+)$/);
    if (decimal && decimal[1].length !== 3) {
      return num(limpio.slice(0, -decimal[0].length).replace(/[.,]/g, "") + decimal[0].replace(",", "."));
    }
    return num(limpio.replace(/[.,]/g, ""));
  }
  return num(limpio);
}

function normalizarFilaLpn(row) {
  const bultos = cantidadLpn(campo(row, ["BULTOS", "Bultos", "CS", "CASE"]));
  const unidades = cantidadLpn(campo(row, ["UnAct", "UNACT", "Un Act", "UN ACT", "UNIDADES", "Unidades", "Un Rcb", "UN RCB"]));
  return {
    raw: row,
    lpn: limpiar(campo(row, ["LPN", "Nro LPN", "NRO LPN", "NRO_LPN", "Nbr LPN", "NBR LPN"])),
    estado: limpiar(campo(row, ["ESTADO", "Estado"])),
    ubicacion: limpiar(campo(row, ["UBICACION", "Ubicacion", "Ubicación"])),
    codigo: limpiar(campo(row, ["CODIGO", "Codigo", "PRODUCTO", "Producto"])),
    codigoAlt: limpiar(campo(row, ["CODIGO_ALT", "COD_ALT", "CODIGO ALTERNATIVO", "Codigo Alternativo", "Cod Alternat"])),
    estilo: limpiar(campo(row, ["ESTILO", "Estilo", "STYLE", "Style", "MODELO", "Modelo"])),
    descripcion: limpiar(campo(row, ["DESCRIPCION", "Descripcion", "Descripción"])),
    bultos,
    unidades: unidades || bultos,
    fecha: limpiar(campo(row, ["FECHA ANTIGÜEDAD", "FECHA ANTIGUEDAD", "FECHA", "Fecha", "Fe y Hr Almacena", "Fe Y Hr Modif", "Fe Hr Recibo", "Fe y Hr Creac", "Fecha Priorid"]))
  };
}

function normalizarFilaProducto(row) {
  return {
    raw: row,
    codigo: normalizar(campo(row, ["CODIGO", "Codigo", "PRODUCTO", "Producto"])),
    codigoAlt: limpiar(campo(row, ["CODIGO_ALT", "COD_ALT", "CODIGO ALTERNATIVO", "Codigo Alternativo", "Cod Alternat"])),
    estilo: limpiar(campo(row, ["ESTILO", "Estilo", "STYLE", "Style", "MODELO", "Modelo"])),
    descripcion: limpiar(campo(row, ["DESCRIPCION", "Descripcion", "Descripción", "DESCRIPCION ARTICULO"])),
    uxb: cantidadLpn(campo(row, ["UXB", "Uxb", "Und x Caja", "UND X CAJA", "UNIDAD_BULTO"]))
  };
}

function normalizarFilaInventario(row) {
  const codigo = normalizar(campo(row, ["PRODUCTO", "CODIGO", "Codigo"]));
  const producto = productoPorCodigo(codigo);
  const uxb = cantidadLpn(campo(row, ["UXB", "Uxb", "Und x Caja", "UND X CAJA"])) || producto?.uxb || 1;
  const unact = cantidadLpn(campo(row, ["UNACT", "UnAct", "Un Act", "UN ACT"]));
  const uniAsig = cantidadLpn(campo(row, ["UNI_ASIG", "UN_ASIG", "Un Asig", "UN ASIG", "UNIDADES ASIGNADAS"]));
  const transito = cantidadLpn(campo(row, ["En las Unidades de TrÃ¡nsito", "En las Unidades de Tránsito", "TRANSITO", "Transito"]));
  const uniMax = cantidadLpn(campo(row, ["UNI_MAX", "Un Max", "UN MAX"]));
  return {
    raw: row,
    codigo,
    codigoAlt: limpiar(campo(row, ["COD_ALT", "CODIGO_ALT", "Codigo Alternativo"])) || producto?.codigoAlt || "",
    estilo: limpiar(campo(row, ["ESTILO", "Estilo", "STYLE", "Style", "MODELO", "Modelo"])) || producto?.estilo || "",
    descripcion: limpiar(campo(row, ["DESCRIPCION", "Descripcion", "Descripción"])) || producto?.descripcion || "",
    ubicacion: limpiar(campo(row, ["UBICACION", "Ubicacion", "Ubicación"])),
    unact,
    uniAsig,
    transito,
    uniMax,
    uxb,
    bultos: uxb ? unact / uxb : unact
  };
}

function productoPorCodigo(codigo) {
  const key = normalizar(codigo);
  return indiceProducto.get(key) || null;
}

function construirIndicesRf() {
  indiceLpn = new Map();
  indiceLpnCodigo = new Map();
  dataLPN.forEach(row => {
    const lpn = normalizar(row.lpn);
    const codigo = normalizar(row.codigo);
    if (lpn) {
      const filasLpn = indiceLpn.get(lpn);
      if (filasLpn) filasLpn.push(row);
      else indiceLpn.set(lpn, [row]);
    }
    if (codigo) {
      const filasCodigo = indiceLpnCodigo.get(codigo);
      if (filasCodigo) filasCodigo.push(row);
      else indiceLpnCodigo.set(codigo, [row]);
    }
  });
  indiceProducto = new Map(dataProductos.map(row => [row.codigo, row]));
}

async function cargarReportes(generacion = generacionCargaRf) {
  if (reportesCargados) return;
  if (cargandoReportes) return cargandoReportes;
  cargandoReportes = Promise.all([
    cargarOpcionalDesde(BI_SHEET_ID, "PICKING"),
    cargarOpcionalDesde(BI_SHEET_ID, "RECEPCION"),
    cargarOpcionalDesde(RECEPCION_PROVEEDORES_SHEET_ID, "RESUMEN"),
    cargarOpcionalDesde(BI_SHEET_ID, "CARGA"),
    cargarOpcionalDesde(BI_SHEET_ID, "CARTONES"),
    cargarOpcionalDesde(BI_SHEET_ID, "PRODUCTOS"),
    cargarOpcionalDesde(BI_SHEET_ID, "USUARIO")
  ]).then(([pickingReporte, recepcionReporte, proveedoresResumen, cargaReporte, cartonesReporte, productosReporte, usuariosReporte]) => {
    if (generacion !== generacionCargaRf) return;
    dataPickingReporte = pickingReporte;
    dataRecepcionReporte = recepcionReporte;
    dataRecepcionProveedoresResumen = proveedoresResumen;
    dataCargaReporte = cargaReporte;
    dataCartonesReporte = cartonesReporte;
    dataProductosReporte = productosReporte;
    dataUsuariosReporte = usuariosReporte;
    reportesCargados = true;
    estado(`${fmt(dataLPN.length)} LPNs | PICK ${fmt(dataPickingReporte.length)} | USU ${fmt(dataUsuariosReporte.length)} | REC ${fmt(dataRecepcionReporte.length)} | DESP ${fmt(dataCartonesReporte.length)}`);
  }).finally(() => {
    if (generacion === generacionCargaRf) cargandoReportes = null;
  });
  return cargandoReportes;
}

async function cargarDatosOperativos(generacion = generacionCargaRf) {
  if (datosOperativosListos) return;
  if (cargandoDatosOperativos) return cargandoDatosOperativos;
  estado("LPNS lista | cargando data operativa...");
  cargandoDatosOperativos = Promise.all([
    cargarOpcional("PEDIDO"),
    cargarOpcional("PRODUCTOS"),
    cargarOpcional("INV_ACTIVO"),
    cargarOpcional("UBICACION"),
    cargarOpcional("BLOQUEO")
  ]).then(([pedido, productos, inventario, ubicaciones, bloqueo]) => {
    if (generacion !== generacionCargaRf) return;
    dataProductos = productos.map(normalizarFilaProducto).filter(row => row.codigo);
    indiceProducto = new Map(dataProductos.map(row => [row.codigo, row]));
    dataPedido = pedido;
    dataInventario = inventario.map(normalizarFilaInventario).filter(row => row.codigo);
    dataUbicaciones = ubicaciones;
    dataBloqueo = bloqueo;
    const fallosCriticos = ["PEDIDO", "PRODUCTOS", "INV_ACTIVO"].filter(nombre => fallosCarga.has(nombre));
    datosOperativosListos = fallosCriticos.length === 0;
    estado(datosOperativosListos
      ? `${fmt(dataLPN.length)} LPNs | data operativa lista`
      : `${fmt(dataLPN.length)} LPNs | revisar: ${fallosCriticos.join(", ")}`);
    if (typeof actualizarVistaRf === "function") actualizarVistaRf();
  }).catch(error => {
    console.warn("No se pudo completar la data operativa:", error.message || error);
    estado(`${fmt(dataLPN.length)} LPNs | data operativa con incidencias`);
  }).finally(() => {
    if (generacion === generacionCargaRf) cargandoDatosOperativos = null;
  });
  return cargandoDatosOperativos;
}

async function cargarDatos(opciones = {}) {
  const generacion = ++generacionCargaRf;
  datosListos = false;
  datosOperativosListos = false;
  cargandoDatosOperativos = null;
  reportesCargados = false;
  cargandoReportes = null;
  fallosCarga = new Set();
  estado("Cargando data RF...");
  const lpns = await cargarHoja("LPNS");
  dataLPN = lpns.map(normalizarFilaLpn).filter(row => row.lpn);
  construirIndicesRf();
  datosListos = true;
  cargarDatosOperativos(generacion);
}
