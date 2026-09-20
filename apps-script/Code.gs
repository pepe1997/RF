const CONFIG = {
  SPREADSHEET_ID: "1GY4EfroTQYqidPML5xj4qShkInKEnjWwJ7zSFGJEWsE",
  HOJA_AVANCE: "AVANCE_TRABAJO",
  TIMEZONE: "America/Lima"
};

const HEADERS = [
  "CLAVE",
  "ESTADO",
  "OPERADOR",
  "ACTUALIZADO",
  "ORIGEN",
  "CODIGO",
  "UBICACION",
  "LPN",
  "BULTOS"
];

function doGet(e) {
  try {
    asegurarHoja_();
    const action = normalizar_(e && e.parameter && e.parameter.action || "HEALTH");
    if (action === "ESTADO") return json_({ ok: true, estados: leerEstados_() });
    return json_({ ok: true, mensaje: "API Trabajo RF operativa." });
  } catch (error) {
    return json_({ ok: false, mensaje: error.message || String(error) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(5000)) throw new Error("Sistema ocupado. Intenta nuevamente.");
    asegurarHoja_();
    const body = JSON.parse(e && e.postData && e.postData.contents || "{}");
    const action = normalizar_(body.action);
    if (action === "ACTUALIZAR") return json_(actualizarEstado_(body));
    if (action === "REGISTRAR_TAREAS") return json_(registrarTareas_(body.tareas || []));
    if (action === "RESET") return json_(reiniciarAvance_());
    return json_({ ok: false, mensaje: "Accion POST no reconocida." });
  } catch (error) {
    return json_({ ok: false, mensaje: error.message || String(error) });
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
}

function configurarSistema() {
  asegurarHoja_();
  return "Hoja AVANCE_TRABAJO configurada.";
}

function asegurarHoja_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  let sheet = ss.getSheetByName(CONFIG.HOJA_AVANCE);
  if (!sheet) sheet = ss.insertSheet(CONFIG.HOJA_AVANCE);
  const actuales = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS.length)).getDisplayValues()[0]
    : [];
  if (HEADERS.some((header, index) => actuales[index] !== header)) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground("#172033")
      .setFontColor("#ffffff")
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
}

function actualizarEstado_(body) {
  const registro = body.registro || {};
  const clave = limpiar_(registro.clave);
  const operador = limpiar_(registro.operador) || "SIN IDENTIFICAR";
  const estado = normalizar_(registro.estado || "PENDIENTE");
  if (!clave) throw new Error("Falta la clave de la tarea.");
  if (["PENDIENTE", "EN PROCESO", "COMPLETO"].indexOf(estado) < 0) {
    throw new Error("Estado de tarea no valido.");
  }

  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.HOJA_AVANCE);
  const fila = buscarFila_(sheet, clave);
  const existente = fila ? sheet.getRange(fila, 1, 1, HEADERS.length).getDisplayValues()[0] : null;
  if (estado === "COMPLETO" && existente && normalizar_(existente[1]) === "COMPLETO" && normalizar_(existente[2]) !== normalizar_(operador)) {
    return {
      ok: false,
      conflicto: true,
      mensaje: `La tarea ya fue completada por ${existente[2] || "otro operador"}.`,
      estado: "COMPLETO",
      operador: existente[2]
    };
  }

  const ahora = new Date();
  const valores = [[
    clave,
    estado,
    operador,
    ahora,
    limpiar_(registro.origen),
    limpiar_(registro.codigo),
    limpiar_(registro.ubicacion),
    limpiar_(registro.lpn),
    numero_(registro.bultos)
  ]];
  if (fila) sheet.getRange(fila, 1, 1, HEADERS.length).setValues(valores);
  else sheet.appendRow(valores[0]);
  return { ok: true, clave, estado, operador, actualizado: ahora.toISOString() };
}

function registrarTareas_(tareas) {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.HOJA_AVANCE);
  const existentes = new Set();
  const last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 1).getDisplayValues().forEach(row => {
      if (row[0]) existentes.add(limpiar_(row[0]));
    });
  }
  const nuevas = [];
  (Array.isArray(tareas) ? tareas : []).forEach(tarea => {
    const clave = limpiar_(tarea.clave);
    if (!clave || existentes.has(clave)) return;
    nuevas.push([
      clave,
      "PENDIENTE",
      "",
      new Date(),
      limpiar_(tarea.origen),
      limpiar_(tarea.codigo),
      limpiar_(tarea.ubicacion),
      limpiar_(tarea.lpn),
      Number(tarea.bultos || 0)
    ]);
    existentes.add(clave);
  });
  if (nuevas.length) sheet.getRange(sheet.getLastRow() + 1, 1, nuevas.length, HEADERS.length).setValues(nuevas);
  return { ok: true, registradas: nuevas.length, total: existentes.size };
}

function reiniciarAvance_() {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.HOJA_AVANCE);
  const last = sheet.getLastRow();
  const eliminadas = Math.max(0, last - 1);
  if (eliminadas) sheet.getRange(2, 1, eliminadas, HEADERS.length).clearContent();
  return { ok: true, eliminadas };
}

function leerEstados_() {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.HOJA_AVANCE);
  const last = sheet.getLastRow();
  if (last < 2) return {};
  const rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues();
  const estados = {};
  rows.forEach(row => {
    const clave = limpiar_(row[0]);
    if (!clave) return;
    estados[clave] = {
      estado: normalizar_(row[1] || "PENDIENTE"),
      operador: limpiar_(row[2]),
      actualizado: limpiar_(row[3]),
      origen: limpiar_(row[4]),
      codigo: limpiar_(row[5]),
      ubicacion: limpiar_(row[6]),
      lpn: limpiar_(row[7]),
      bultos: numero_(row[8])
    };
  });
  return estados;
}

function buscarFila_(sheet, clave) {
  if (sheet.getLastRow() < 2) return 0;
  const found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(clave)
    .matchEntireCell(true)
    .findNext();
  return found ? found.getRow() : 0;
}

function limpiar_(valor) {
  return String(valor === null || valor === undefined ? "" : valor).trim();
}

function normalizar_(valor) {
  return limpiar_(valor).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function numero_(valor) {
  let texto = limpiar_(valor).replace(/\s/g, "");
  if (!texto) return 0;
  if (texto.includes(",") && texto.includes(".")) {
    if (texto.lastIndexOf(",") > texto.lastIndexOf(".")) {
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else {
      texto = texto.replace(/,/g, "");
    }
  } else if (texto.includes(",")) {
    const decimales = texto.split(",")[1] || "";
    texto = decimales.length === 3 ? texto.replace(/,/g, "") : texto.replace(",", ".");
  }
  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function json_(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}
