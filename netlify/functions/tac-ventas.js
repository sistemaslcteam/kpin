// netlify/functions/tac-ventas.js
//
// Endpoint resultante: /.netlify/functions/tac-ventas?desde=2026-08-01&hasta=2026-08-31
//
// Qué hace:
//   El Dashboard TAC, cada vez que alguien sube un Excel ahí, guarda los renglones
//   en un archivo JSON público dentro de un repo de GitHub (esto ya lo tenían
//   armado, no es nuevo). Esta función lee ese mismo archivo, lo filtra por rango
//   de fechas y lo agrega por vendedor — así el KPI'S muestra siempre lo último
//   que se haya subido al Dashboard TAC, sin duplicar la carga de datos.
//
// No necesita variables de entorno: el repo es público.
// Si en algún momento cambian el repo/rama donde el Dashboard TAC guarda sus datos
// (Configuración ⚙️ dentro del Dashboard TAC), actualiza GH_REPO / GH_BRANCH abajo.

const GH_REPO = "sistemaslcteam/dashboard-tac";
const GH_BRANCH = "main";
const GH_FILE = "data/ventas.json";

// Posiciones de columna dentro de cada renglón (mismo orden que usa el Dashboard TAC)
const COL = {
  FECHA: 2, CLIENTE: 3, VENDEDOR: 4, VENTA: 9, COSTO: 10, UTIL: 11,
};

exports.handler = async (event) => {
  try {
    const { desde, hasta } = event.queryStringParameters || {};
    if (!desde || !hasta) {
      return jsonResponse(400, { error: "Faltan los parámetros 'desde' y 'hasta' (YYYY-MM-DD)." });
    }

    const url = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${GH_FILE}?t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) {
      return jsonResponse(502, { error: `No se pudo leer ${GH_FILE} del Dashboard TAC (HTTP ${res.status}). ¿Ya subieron un Excel alguna vez ahí?` });
    }
    const rows = await res.json();

    const porVendedor = {};
    const asegurar = (nombre) => {
      if (!porVendedor[nombre]) porVendedor[nombre] = { nombre, venta: 0, util: 0, clientes: new Set() };
      return porVendedor[nombre];
    };

    for (const r of rows) {
      const fecha = r[COL.FECHA]; // formato DD/MM/AAAA
      if (!fecha || typeof fecha !== "string") continue;
      const [dd, mm, yyyy] = fecha.split("/");
      if (!dd || !mm || !yyyy) continue;
      const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
      if (iso < desde || iso > hasta) continue;

      const v = asegurar(r[COL.VENDEDOR] || "Sin asignar");
      v.venta += Number(r[COL.VENTA]) || 0;
      v.util += Number(r[COL.UTIL]) || 0;
      if (r[COL.CLIENTE]) v.clientes.add(r[COL.CLIENTE]);
    }

    const vendedores = Object.values(porVendedor).map(v => ({
      nombre: v.nombre,
      venta: Math.round(v.venta),
      margenPct: v.venta ? +((v.util / v.venta) * 100).toFixed(1) : null,
      clientesUnicos: v.clientes.size,
    }));

    return jsonResponse(200, { desde, hasta, vendedores });
  } catch (err) {
    return jsonResponse(500, { error: "Error leyendo datos del Dashboard TAC", detalle: String(err) });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
