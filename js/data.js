const SHEET_ID = "1-v6vXjHpLlIn0-_lVZw0BtGopnxSHH0zqoOrW8aBwcg";

let dataLPN = [];
let dataProductos = [];
let dataInventario = [];
let dataUbicaciones = [];
let dataBloqueo = [];
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

async function cargarOpcional(nombre) {
  try {
    return await cargarHoja(nombre);
  } catch (error) {
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
  return dataProductos.find(row => row.codigo === key);
}

async function cargarDatos() {
  datosListos = false;
  estado("Cargando data RF...");
  const [lpns, productos, inventario, ubicaciones, bloqueo] = await Promise.all([
    cargarHoja("LPNS"),
    cargarOpcional("PRODUCTOS"),
    cargarOpcional("INV_ACTIVO"),
    cargarOpcional("UBICACION"),
    cargarOpcional("BLOQUEO")
  ]);
  dataProductos = productos.map(normalizarFilaProducto).filter(row => row.codigo);
  dataLPN = lpns.map(normalizarFilaLpn).filter(row => row.lpn);
  dataInventario = inventario.map(normalizarFilaInventario).filter(row => row.codigo);
  dataUbicaciones = ubicaciones;
  dataBloqueo = bloqueo;
  datosListos = true;
  estado(`${fmt(dataLPN.length)} LPNs | ${fmt(dataInventario.length)} activos`);
}
