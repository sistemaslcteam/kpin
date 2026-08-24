// netlify/functions/odoo-ventas.js
//
// Endpoint resultante: /.netlify/functions/odoo-ventas?desde=2026-08-01&hasta=2026-08-31
//
// Qué hace:
//   1. Se autentica en Odoo por JSON-RPC con un usuario de solo lectura.
//   2. Consulta las órdenes de venta confirmadas en el rango de fechas.
//   3. Trae las líneas de esas órdenes (producto, cantidad, subtotal de venta).
//   4. Trae el costo (standard_price) de cada producto involucrado.
//   5. Calcula el margen = (venta - costo) / venta, por vendedor.
//      Esto NO depende del módulo "Márgenes de venta" (sale_margin) — se calcula
//      directo desde el costo estándar del producto, que sí existe en Odoo base.
//
// Variables de entorno que necesita (Netlify > Site settings > Environment variables):
//   ODOO_URL       -> ej. https://pinerp.odoo.com
//   ODOO_DB        -> nombre de la base de datos de Odoo
//   ODOO_USER      -> usuario de solo lectura dedicado a esta herramienta
//   ODOO_PASSWORD  -> API key de ese usuario

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

    const exec = (model, method, args, kwargs) =>
      odooCall(ODOO_URL, "object", "execute_kw", [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs || {}]);

    // 2) Buscamos las órdenes de venta confirmadas en el rango de fechas
    const orders = await exec(
      "sale.order", "search_read",
      [[
        ["state", "in", ["sale", "done"]],
        ["date_order", ">=", `${desde} 00:00:00`],
        ["date_order", "<=", `${hasta} 23:59:59`],
      ]],
      { fields: ["id", "user_id", "amount_total", "partner_id"] }
    );

    if (!orders.length) {
      return jsonResponse(200, { desde, hasta, vendedores: [] });
    }

    const orderIds = orders.map(o => o.id);
    const vendedorPorOrden = {};
    orders.forEach(o => { vendedorPorOrden[o.id] = o.user_id ? o.user_id[1] : "Sin asignar"; });

    // 3) Líneas de esas órdenes: producto, cantidad y subtotal de venta
    const lineas = await exec(
      "sale.order.line", "search_read",
      [[
        ["order_id", "in", orderIds],
        ["product_id", "!=", false],
        ["display_type", "=", false], // excluye secciones/notas, que no son producto real
      ]],
      { fields: ["order_id", "product_id", "product_uom_qty", "price_subtotal"] }
    );

    // 4) Costo estándar de cada producto involucrado (una sola consulta, sin duplicados)
    const productIds = [...new Set(lineas.map(l => l.product_id[0]))];
    const productos = productIds.length
      ? await exec("product.product", "read", [productIds], { fields: ["standard_price"] })
      : [];
    const costoPorProducto = {};
    productos.forEach(p => { costoPorProducto[p.id] = p.standard_price || 0; });

    // 5) Agregamos venta, costo y clientes por vendedor
    const porVendedor = {};
    const asegurar = (nombre) => {
      if (!porVendedor[nombre]) porVendedor[nombre] = { nombre, venta: 0, costo: 0, clientesUnicos: new Set() };
      return porVendedor[nombre];
    };

    orders.forEach(o => {
      const v = asegurar(vendedorPorOrden[o.id]);
      if (o.partner_id) v.clientesUnicos.add(o.partner_id[0]);
    });

    lineas.forEach(l => {
      const vendedor = vendedorPorOrden[l.order_id[0]];
      const v = asegurar(vendedor);
      const costoUnit = costoPorProducto[l.product_id[0]] || 0;
      v.venta += l.price_subtotal || 0;
      v.costo += costoUnit * (l.product_uom_qty || 0);
    });

    const vendedores = Object.values(porVendedor).map(v => ({
      nombre: v.nombre,
      venta: Math.round(v.venta),
      margenPct: v.venta ? +(((v.venta - v.costo) / v.venta) * 100).toFixed(1) : null,
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
