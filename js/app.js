const RF_USER = "SCANER";
const RF_PASS = "1234";

let scannerStream = null;
let scannerDetector = null;
let scannerActivo = false;

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
  recargarDatos();
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

async function recargarDatos() {
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
      boton.textContent = "Actualizar";
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
  buscarLpn(document.getElementById("lpnInput").value);
}

function buscarLpn(valor) {
  const lpn = normalizar(valor);
  if (!lpn) return enfocarLpn();
  if (!datosListos) {
    mostrarMensaje("Data cargando", "Espera unos segundos y vuelve a escanear.");
    return;
  }

  const rows = dataLPN.filter(row => normalizar(row.lpn) === lpn);
  document.getElementById("lpnInput").value = "";
  if (!rows.length) {
    mostrarMensaje("LPN no encontrado", lpn, true);
    return enfocarLpn();
  }

  renderLpn(rows);
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

function renderLpn(rows) {
  const first = rows[0];
  const totalBultos = rows.reduce((a, b) => a + b.bultos, 0);
  const totalUnidades = rows.reduce((a, b) => a + b.unidades, 0);
  const codigos = new Set(rows.map(row => row.codigo).filter(Boolean)).size;
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
        ${rows.map(row => `
          <div class="product-row">
            <h3>${htmlSeguro(row.codigo || "-")}${row.codigoAlt ? ` | ${htmlSeguro(row.codigoAlt)}` : ""}</h3>
            <p>${htmlSeguro(row.descripcion || "Sin descripcion")}</p>
            <div class="product-metrics">
              <b>${fmt(row.bultos)}<small>Bultos</small></b>
              <b>${fmt(row.unidades)}<small>Unidades</small></b>
              <b>${htmlSeguro(row.fecha || "-")}<small>Fecha</small></b>
            </div>
          </div>
        `).join("")}
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
      buscarLpn(valor);
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
document.getElementById("refreshButton").addEventListener("click", recargarDatos);
document.getElementById("logoutButton").addEventListener("click", salir);
document.getElementById("cameraButton").addEventListener("click", alternarCamara);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) detenerCamara();
});

mostrarLogin();
