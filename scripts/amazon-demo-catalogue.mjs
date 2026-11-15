// Genuine local catalogue data, explicitly not a saved or live retailer page.
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export async function cataloguePage() {
  const response = await fetch('http://127.0.0.1:8013/products');
  if (!response.ok) throw Error('Local catalogue unavailable');
  const products = await response.json(),
    product = products.find((p) => /\/dp\/[A-Z0-9]{10}/.test(p.url));
  if (!product) throw Error('No genuine Amazon-mapped catalogue product');
  const asin = /\/dp\/([A-Z0-9]{10})/.exec(product.url)[1];
  const fields = ['chest', 'shoulder', 'sleeve', 'length_hps'];
  // Printed like a real size chart: 0.1 cm. The Fit Agent ranks this catalogue jacket with the
  // full engine on the unrounded catalogue data; these printed values feed only its cross-check.
  const printed = (value) => (Number.isFinite(value) ? String(Math.round(value * 10) / 10) : null);
  const rows = Object.entries(product.sizes)
    .map(
      ([name, size]) =>
        `<tr><td>${escape(name)}</td>${fields.map((field) => `<td>${escape(printed(size[field]?.value_cm) ?? 'not measured')}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local measured catalogue demonstration</title><style>body{font:16px/1.5 system-ui;max-width:760px;margin:40px;background:#edf3ef;color:#172a26}td,th{padding:10px;border-bottom:1px solid #aabbb3;text-align:left}table{border-collapse:collapse}</style><h1 id="productTitle">${escape(product.brand)} ${escape(product.style ?? '')} ${escape(product.category)} — local catalogue</h1><p><strong>Local catalogue demonstration — not a saved or live Amazon page.</strong></p><p>Owned-size tape measurements; other sizes are estimated by grading. These are the real local product data, not a fabricated size chart. Printed to 0.1 cm, like a retailer chart; the fit engine uses the unrounded values.</p><p>Source listing: ${escape(product.url)}</p><p id="bylineInfo">Brand: ${escape(product.brand)}</p><input id="ASIN" name="ASIN" type="hidden" value="${asin}"><label>Size <select id="size_name">${Object.keys(
    product.sizes,
  )
    .map((name) => `<option>${escape(name)}</option>`)
    .join(
      '',
    )}</select></label><table><caption>Garment measurements (cm), local tapes and estimated grades</caption><tr><th>Size</th><th>Chest</th><th>Shoulder</th><th>Sleeve</th><th>Length</th></tr>${rows}</table></html>`;
}
