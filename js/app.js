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
    enfocarLpn();
    return;
  }
  const boton = document.getElementById("refreshButton");
  if (boton) {
    boton.disabled = true;
    boton.textContent = "Leyendo...";
  }
  try {
    await cargarDatos();
    enfocarLpn();
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
document.addEventListener("visibilitychange", () => {
  if (document.hidden) detenerCamara();
});

mostrarLogin();
