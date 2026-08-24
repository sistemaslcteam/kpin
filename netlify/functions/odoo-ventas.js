// netlify/functions/odoo-ventas.js
//
// Endpoint resultante: /.netlify/functions/odoo-ventas?desde=2026-08-01&hasta=2026-08-31
//
// Qué hace:
//   1. Se autentica en Odoo por JSON-RPC con un usuario de solo lectura.
//   2. Consulta las órdenes de venta confirmadas en el rango de fechas.
//   3. Agrupa el total y el margen por vendedor.
//   4. Regresa un JSON limpio, listo para pintar en la Torre de Control.
//
// Variables de entorno que necesita (Netlify > Site settings > Environment variables):
//   ODOO_URL       -> ej. https://pin.odoo.com
//   ODOO_DB        -> nombre de la base de datos de Odoo
//   ODOO_USER      -> usuario de solo lectura dedicado a esta herramienta
//   ODOO_PASSWORD  -> contraseña o API key de ese usuario

exports.handler = async (event) => {
  try {
    const { desde, hasta } = event.queryStringParameters || {};
    if (!desde || !hasta) {
      return jsonResponse(400, { error: "Faltan los parámetros 'desde' y 'hasta' (YYYY-MM-DD)." });
    }

    const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD } = process.env;
    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      return jsonResponse(500, { error: "Faltan variables de entorno de Odoo en Netlify." });
    }

    // 1) Login -> obtenemos el uid de Odoo
    const uid = await odooCall(ODOO_URL, "common", "login", [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
    if (!uid) return jsonResponse(401, { error: "No se pudo autenticar en Odoo. Revisa usuario/contraseña." });

    // 2) Buscamos las órdenes de venta confirmadas en el rango de fechas
    const orderIds = await odooCall(ODOO_URL, "object", "execute_kw", [
      ODOO_DB, uid, ODOO_PASSWORD,
      "sale.order", "search",
      [[
        ["state", "in", ["sale", "done"]],
        ["date_order", ">=", `${desde} 00:00:00`],
        ["date_order", "<=", `${hasta} 23:59:59`],
      ]],
    ]);

    if (!orderIds.length) {
      return jsonResponse(200, { desde, hasta, vendedores: [] });
    }

    // 3) Leemos los campos que nos interesan de esas órdenes
    const orders = await odooCall(ODOO_URL, "object", "execute_kw", [
      ODOO_DB, uid, ODOO_PASSWORD,
      "sale.order", "read",
      [orderIds, ["user_id", "amount_total", "margin", "partner_id"]],
    ]);

    // 4) Agrupamos por vendedor (user_id)
    const porVendedor = {};
    for (const o of orders) {
      const vendedor = o.user_id ? o.user_id[1] : "Sin asignar";
      if (!porVendedor[vendedor]) {
        porVendedor[vendedor] = { nombre: vendedor, venta: 0, margen: 0, clientesUnicos: new Set() };
      }
      porVendedor[vendedor].venta += o.amount_total || 0;
      porVendedor[vendedor].margen += o.margin || 0;
      if (o.partner_id) porVendedor[vendedor].clientesUnicos.add(o.partner_id[0]);
    }

    const vendedores = Object.values(porVendedor).map(v => ({
      nombre: v.nombre,
      venta: Math.round(v.venta),
      margenPct: v.venta ? +((v.margen / v.venta) * 100).toFixed(1) : 0,
      clientesUnicos: v.clientesUnicos.size,
    }));

    return jsonResponse(200, { desde, hasta, vendedores });
  } catch (err) {
    return jsonResponse(500, { error: "Error consultando Odoo", detalle: String(err) });
  }
};

// Helper: llamada JSON-RPC genérica a Odoo
async function odooCall(baseUrl, service, method, args) {
  const res = await fetch(`${baseUrl}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.floor(Math.random() * 1000000),
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
