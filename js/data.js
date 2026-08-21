const SHEET_ID = "1-v6vXjHpLlIn0-_lVZw0BtGopnxSHH0zqoOrW8aBwcg";

let dataLPN = [];
let datosListos = false;

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
  const url = `https://opensheet.elk.sh/${SHEET_ID}/${encodeURIComponent(nombre)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
  return await res.json();
}

function cantidad(valor) {
  const texto = limpiar(valor);
  if (!texto) return 0;
  return num(texto);
}

function normalizarFilaLpn(row) {
  const bultos = cantidad(campo(row, ["BULTOS", "Bultos", "CS", "CASE"]));
  const unidades = cantidad(campo(row, ["UnAct", "UNACT", "Un Act", "UN ACT", "UNIDADES", "Unidades", "Un Rcb", "UN RCB"]));
  return {
    raw: row,
    lpn: limpiar(campo(row, ["LPN", "Nro LPN", "NRO LPN", "NRO_LPN", "Nbr LPN", "NBR LPN"])),
    estado: limpiar(campo(row, ["ESTADO", "Estado"])),
    ubicacion: limpiar(campo(row, ["UBICACION", "Ubicacion", "Ubicación"])),
    codigo: limpiar(campo(row, ["CODIGO", "Codigo", "PRODUCTO", "Producto"])),
    codigoAlt: limpiar(campo(row, ["CODIGO_ALT", "COD_ALT", "CODIGO ALTERNATIVO", "Codigo Alternativo", "Cod Alternat"])),
    descripcion: limpiar(campo(row, ["DESCRIPCION", "Descripcion", "Descripción"])),
    bultos,
    unidades: unidades || bultos,
    fecha: limpiar(campo(row, ["FECHA ANTIGÜEDAD", "FECHA ANTIGUEDAD", "FECHA", "Fecha", "Fe y Hr Almacena", "Fe Y Hr Modif", "Fe Hr Recibo", "Fe y Hr Creac", "Fecha Priorid"]))
  };
}

async function cargarDatos() {
  datosListos = false;
  estado("Cargando LPNS...");
  const lpns = await cargarHoja("LPNS");
  dataLPN = lpns.map(normalizarFilaLpn).filter(row => row.lpn);
  datosListos = true;
  estado(`${fmt(dataLPN.length)} LPNs cargados`);
}
