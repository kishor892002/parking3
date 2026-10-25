/* ParkEase payment server – no dependencies, needs Node 18 or newer.
 *
 *   node server/server.js
 *
 * It does two jobs:
 *   1. Serves the website (so the site and the API share one address).
 *   2. Creates a payment QR for each bill and reports when it has been paid,
 *      so the website can check the vehicle out automatically.
 *
 * Modes (chosen from environment variables, see .env.example):
 *   razorpay – real payments through Razorpay UPI QR codes
 *   mock     – demo mode with a "Simulate payment" button (MOCK=1)
 *   off      – no keys set; the website falls back to the manual flow
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/* ---------- Tiny .env loader ---------- */
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
})();

const PORT = Number(process.env.PORT) || 3000;
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const RZP_BASE = (process.env.RAZORPAY_BASE || 'https://api.razorpay.com').replace(/\/$/, '');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // only needed if the site is hosted elsewhere
const UPI_ID = process.env.UPI_ID || '7754084726-4@ibl';   // demo mode only
const UPI_NAME = process.env.UPI_NAME || 'RAJ MAURYA';     // demo mode only

const MODE = process.env.MOCK === '1' ? 'mock' : (KEY_ID && KEY_SECRET ? 'razorpay' : 'off');

/* ---------- In-memory payments ---------- */
// id -> { id, amount, plate, slot, status: 'pending'|'paid'|'closed', paymentId, createdAt, lastCheck }
const payments = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, p] of payments) if (p.createdAt < cutoff) payments.delete(id);
}, 10 * 60 * 1000).unref();

/* ---------- Helpers ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch (e) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

async function razorpay(method, apiPath, body) {
  const res = await fetch(RZP_BASE + apiPath, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.description) || `Razorpay error ${res.status}`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  return data;
}

const publicView = p => ({ id: p.id, status: p.status, amount: p.amount, paymentId: p.paymentId || null });

/* ---------- API handlers ---------- */
async function createPayment(req, res) {
  if (MODE === 'off') return sendJson(res, 503, { error: 'Payments are not configured on the server.' });

  const body = await readJson(req);
  const amount = Number(body.amount);
  const plate = String(body.plate || '').toUpperCase();
  const slot = String(body.slot || '').slice(0, 6);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return sendJson(res, 400, { error: 'Invalid amount.' });
  if (!/^[A-Z0-9]{4,12}$/.test(plate)) return sendJson(res, 400, { error: 'Invalid vehicle number.' });

  let record;
  let imageUrl = null;
  let upiLink = null;

  if (MODE === 'mock') {
    const id = 'mock_' + crypto.randomBytes(6).toString('hex');
    record = { id, amount, plate, slot };
    upiLink = `upi://pay?pa=${UPI_ID}&pn=${encodeURIComponent(UPI_NAME)}&am=${amount}.00&cu=INR&tn=${encodeURIComponent('Parking ' + plate)}`;
  } else {
    // Single-use QR with a fixed amount: the customer cannot change it, and
    // Razorpay links the incoming payment to this QR.
    const qr = await razorpay('POST', '/v1/payments/qr_codes', {
      type: 'upi_qr',
      name: 'ParkEase',
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: amount * 100, // paise
      description: `Parking ${plate}`,
      close_by: Math.floor(Date.now() / 1000) + 15 * 60,
      notes: { plate, slot }
    });
    record = { id: qr.id, amount, plate, slot };
    imageUrl = qr.image_url || null;
    upiLink = typeof qr.image_content === 'string' && qr.image_content.startsWith('upi://') ? qr.image_content : null;
  }

  Object.assign(record, { status: 'pending', createdAt: Date.now(), lastCheck: 0 });
  payments.set(record.id, record);
  sendJson(res, 201, { ...publicView(record), mode: MODE, imageUrl, upiLink });
}

async function getPayment(req, res, id) {
  const p = payments.get(id);
  if (!p) return sendJson(res, 404, { error: 'Unknown payment.' });

  // Razorpay mode: ask Razorpay whether money has arrived (works without webhooks).
  if (MODE === 'razorpay' && p.status === 'pending' && Date.now() - p.lastCheck > 2000) {
    p.lastCheck = Date.now();
    try {
      const list = await razorpay('GET', `/v1/payments/qr_codes/${encodeURIComponent(p.id)}/payments`);
      const hit = (list.items || []).find(x => x.status === 'captured' && x.amount === p.amount * 100);
      if (hit && p.status === 'pending') { p.status = 'paid'; p.paymentId = hit.id; }
    } catch (e) { /* transient – the next poll will retry */ }
  }
  sendJson(res, 200, publicView(p));
}

async function cancelPayment(req, res, id) {
  const p = payments.get(id);
  if (!p) return sendJson(res, 404, { error: 'Unknown payment.' });
  if (p.status === 'pending') {
    p.status = 'closed';
    if (MODE === 'razorpay') razorpay('POST', `/v1/payments/qr_codes/${encodeURIComponent(p.id)}/close`).catch(() => {});
  }
  sendJson(res, 200, publicView(p));
}

function mockPay(req, res, id) {
  if (MODE !== 'mock') return sendJson(res, 404, { error: 'Not found.' });
  const p = payments.get(id);
  if (!p) return sendJson(res, 404, { error: 'Unknown payment.' });
  if (p.status === 'pending') { p.status = 'paid'; p.paymentId = 'mockpay_' + crypto.randomBytes(4).toString('hex'); }
  sendJson(res, 200, publicView(p));
}

// Optional: Razorpay can also push "payment received" to this URL.
async function razorpayWebhook(req, res) {
  if (!WEBHOOK_SECRET) return sendJson(res, 404, { error: 'Webhook not enabled.' });

  const raw = await readBody(req);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const given = String(req.headers['x-razorpay-signature'] || '');
  const ok = given.length === expected.length &&
             crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return sendJson(res, 400, { error: 'Bad signature.' });

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON' }); }

  if (event.event === 'qr_code.credited') {
    const qrId = event.payload && event.payload.qr_code && event.payload.qr_code.entity && event.payload.qr_code.entity.id;
    const pay = event.payload && event.payload.payment && event.payload.payment.entity;
    const p = qrId && payments.get(qrId);
    if (p && p.status === 'pending' && pay && pay.amount === p.amount * 100) {
      p.status = 'paid';
      p.paymentId = pay.id;
    }
  }
  sendJson(res, 200, { ok: true });
}

/* ---------- Static files (the website itself) ---------- */
const STATIC_OK = /^\/(index\.html|style\.css|script\.js|pdf\.js|qr\.js|qr-data\.js|assets\/[\w.-]+)$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png'
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (!STATIC_OK.test(pathname)) return sendJson(res, 404, { error: 'Not found.' });
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT + path.sep)) return sendJson(res, 404, { error: 'Not found.' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ---------- Router ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  try {
    let m;
    if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, mode: MODE });
    if (req.method === 'POST' && pathname === '/api/payments') return await createPayment(req, res);
    if (req.method === 'POST' && pathname === '/api/webhook/razorpay') return await razorpayWebhook(req, res);
    if ((m = pathname.match(/^\/api\/payments\/([\w.-]+)$/)) && req.method === 'GET') return await getPayment(req, res, m[1]);
    if ((m = pathname.match(/^\/api\/payments\/([\w.-]+)\/cancel$/)) && req.method === 'POST') return await cancelPayment(req, res, m[1]);
    if ((m = pathname.match(/^\/api\/mock\/pay\/([\w.-]+)$/)) && req.method === 'POST') return mockPay(req, res, m[1]);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    const label = { razorpay: 'Razorpay (live payments)', mock: 'DEMO mode (simulated payments)', off: 'OFF – no payment keys set, manual flow only' }[MODE];
    console.log(`ParkEase running at http://localhost:${PORT}`);
    console.log(`Payment mode: ${label}`);
  });
}

module.exports = { server };
