'use strict';
// Minimal PostgREST-efterligning med de constraints der faktisk fejlede:
// UNIQUE(products.slug), fremmednøgler og ON DELETE CASCADE på notifications.
const http = require('node:http');

const SCHEMA = {
  chains:       { pk: ['id'], uniq: [], fks: [] },
  products:     { pk: ['id'], uniq: [['slug']], fks: [] },
  stores:       { pk: ['id'], uniq: [], fks: [{ c: 'chain_id', t: 'chains', r: 'id' }] },
  offers:       { pk: ['id'], uniq: [['external_id']], fks: [
                    { c: 'product_id', t: 'products', r: 'id' },
                    { c: 'chain_id', t: 'chains', r: 'id' }] },
  recipes:      { pk: ['id'], uniq: [['url']], fks: [] },
  price_stats:  { pk: ['product_id','base_unit'], uniq: [], fks: [{ c:'product_id', t:'products', r:'id' }] },
  price_series: { pk: ['product_id','base_unit','period'], uniq: [], fks: [{ c:'product_id', t:'products', r:'id' }] },
  meal_plans:   { pk: ['tier','year','week','variant'], uniq: [], fks: [] },
  deals:        { pk: ['offer_id'], uniq: [], fks: [
                    { c:'offer_id', t:'offers', r:'id' }, { c:'product_id', t:'products', r:'id' }] },
  watches:      { pk: ['id'], uniq: [], fks: [] },
  notifications:{ pk: ['id'], uniq: [['watch_id','offer_id']], fks: [
                    { c:'watch_id', t:'watches', r:'id', cascade:true },
                    { c:'offer_id', t:'offers',  r:'id', cascade:true }] },
  sync_state:   { pk: ['key'], uniq: [], fks: [] },
};

const DB = {}; for (const t of Object.keys(SCHEMA)) DB[t] = [];
let seq = 1000;
const key = (row, cols) => cols.map((c) => JSON.stringify(row[c])).join('\u0000');

function matches(row, filters) {
  return filters.every(([col, op, val]) => {
    if (op === 'not.is.null') return row[col] !== null && row[col] !== undefined;
    if (op === 'is.null')     return row[col] === null || row[col] === undefined;
    if (op === 'eq')          return String(row[col]) === val;
    if (op === 'gt')          return Number(row[col]) > Number(val);
    if (op === 'in')          return val.replace(/^\(|\)$/g, '').split(',').includes(String(row[col]));
    return true;
  });
}
function parseFilters(params) {
  const out = [];
  for (const [k, v] of params) {
    if (['select','order','limit','offset','on_conflict'].includes(k)) continue;
    if (v === 'not.is.null' || v === 'is.null') out.push([k, v, null]);
    else { const i = v.indexOf('.'); out.push([k, v.slice(0, i), v.slice(i + 1)]); }
  }
  return out;
}

function insert(table, rows, onConflict) {
  const S = SCHEMA[table];
  const conflictCols = onConflict ? onConflict.split(',') : S.pk;
  for (const row of rows) {
    for (const fk of S.fks) {                                    // fremmednøgler
      const v = row[fk.c];
      if (v === null || v === undefined) continue;
      if (!DB[fk.t].some((p) => String(p[fk.r]) === String(v)))
        throw { code: 409, body: { code: '23503', message:
          `insert or update on table "${table}" violates foreign key constraint on ${fk.c}` } };
    }
    const idx = DB[table].findIndex((r) => key(r, conflictCols) === key(row, conflictCols));
    for (const u of S.uniq) {                                    // unique-constraints
      const clash = DB[table].findIndex((r) => key(r, u) === key(row, u));
      if (clash !== -1 && clash !== idx)
        throw { code: 409, body: { code: '23505',
          details: `Key (${u.join(',')})=(${u.map((c) => row[c]).join(',')}) already exists.`,
          message: `duplicate key value violates unique constraint "${table}_${u.join('_')}_key"` } };
    }
    if (idx === -1) DB[table].push({ id: seq++, ...row }); else DB[table][idx] = { ...DB[table][idx], ...row };
  }
}

function remove(table, filters) {
  const doomed = DB[table].filter((r) => matches(r, filters));
  for (const other of Object.keys(SCHEMA)) {                     // referentiel integritet
    for (const fk of SCHEMA[other].fks) {
      if (fk.t !== table) continue;
      const orphans = DB[other].filter((r) =>
        doomed.some((d) => String(d[fk.r]) === String(r[fk.c])));
      if (!orphans.length) continue;
      if (fk.cascade) DB[other] = DB[other].filter((r) => !orphans.includes(r));
      else throw { code: 409, body: { code: '23503', message:
        `update or delete on table "${table}" violates foreign key constraint on "${other}"` } };
    }
  }
  DB[table] = DB[table].filter((r) => !doomed.includes(r));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const table = u.pathname.replace('/rest/v1/', '');
    const params = [...u.searchParams.entries()];
    const filters = parseFilters(params);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    try {
      if (!SCHEMA[table]) return send(404, { message: `relation ${table} does not exist` });
      if (req.method === 'POST')   { insert(table, JSON.parse(body), u.searchParams.get('on_conflict')); return send(201); }
      if (req.method === 'DELETE') { remove(table, filters); return send(204); }
      if (req.method === 'PATCH')  {
        const patch = JSON.parse(body);
        for (const r of DB[table]) if (matches(r, filters)) Object.assign(r, patch);
        return send(204);
      }
      if (req.method === 'GET') {
        const sel = u.searchParams.get('select') || '*';
        const off = Number(u.searchParams.get('offset') || 0);
        const lim = Number(u.searchParams.get('limit') || 1000);
        let rows = DB[table].filter((r) => matches(r, filters)).slice(off, off + lim);
        const embed = sel.match(/(\w+)\(([^)]+)\)/);            // fx offers(external_id)
        if (embed) {
          const [, et, ecols] = embed;
          const fk = SCHEMA[table].fks.find((f) => f.t === et);
          rows = rows.map((r) => {
            const p = DB[et].find((x) => String(x[fk.r]) === String(r[fk.c]));
            const o = {}; if (p) for (const c of ecols.split(',')) o[c] = p[c];
            return { ...r, [et]: p ? o : null };
          });
        }
        return send(200, rows);
      }
      send(405, { message: 'method not allowed' });
    } catch (e) {
      if (e && e.code === 409) return send(409, e.body);
      send(500, { message: String((e && e.message) || e) });
    }
  });
});

module.exports = { server, DB, insert, SCHEMA };
// Startes af testen, ikke af sig selv.
