// Mock Payment API - zero dependencies, Node.js built-ins only.
// See README.md for the full API contract.

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);

// Outcome rates must sum to 1.0. Override via env vars to tune chaos.
const RATES = {
  success: parseFloat(process.env.SUCCESS_RATE ?? '0.6'),
  latency: parseFloat(process.env.LATENCY_RATE ?? '0.2'),
  timeout: parseFloat(process.env.TIMEOUT_RATE ?? '0.1'),
  down: parseFloat(process.env.DOWN_RATE ?? '0.05'),
  decline: parseFloat(process.env.DECLINE_RATE ?? '0.05'),
};

const LATENCY_MIN_MS = parseInt(process.env.LATENCY_MIN_MS || '500', 10);
const LATENCY_MAX_MS = parseInt(process.env.LATENCY_MAX_MS || '2500', 10);
const TIMEOUT_MIN_MS = parseInt(process.env.TIMEOUT_MIN_MS || '3000', 10);
const TIMEOUT_MAX_MS = parseInt(process.env.TIMEOUT_MAX_MS || '5000', 10);

// idempotencyKey -> { requestHash, statusCode, body }
const completed = new Map();
// idempotencyKey currently being processed (for concurrent-duplicate detection)
const inFlight = new Set();
// paymentId -> { statusCode, body } (for GET /payments/:id)
const byPaymentId = new Map();

function hashBody(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function pickOutcome() {
  const r = Math.random();
  let acc = 0;
  for (const key of ['success', 'latency', 'timeout', 'down', 'decline']) {
    acc += RATES[key];
    if (r < acc) return key;
  }
  return 'success';
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleCreatePayment(req, res) {
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return sendJson(res, 400, { error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required.' });
  }

  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'INVALID_JSON', message: 'Request body must be valid JSON.' });
  }

  if (!payload.referenceId || typeof payload.amount !== 'number' || payload.amount <= 0) {
    return sendJson(res, 400, {
      error: 'INVALID_REQUEST',
      message: 'referenceId (string) and amount (positive number) are required.',
    });
  }

  const requestHash = hashBody(raw);

  const existing = completed.get(idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return sendJson(res, 422, {
        error: 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
        message: 'This Idempotency-Key was already used with a different request body.',
      });
    }
    // True replay: return the exact same outcome as the original request.
    res.writeHead(existing.statusCode, { 'Content-Type': 'application/json', 'Idempotency-Replayed': 'true' });
    return res.end(JSON.stringify(existing.body));
  }

  if (inFlight.has(idempotencyKey)) {
    return sendJson(res, 409, {
      error: 'REQUEST_IN_PROGRESS',
      message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
    });
  }

  inFlight.add(idempotencyKey);
  try {
    const outcome = pickOutcome();
    const paymentId = crypto.randomUUID();

    if (outcome === 'down') {
      // Simulate the service being unavailable. Not cached: a client retry
      // with the same key should get a fresh chance, since nothing was
      // actually processed on this end.
      return sendJson(res, 503, { error: 'SERVICE_UNAVAILABLE', message: 'Payment service is temporarily down.' });
    }

    if (outcome === 'timeout') {
      // Delay at the edge of what a well-configured client should tolerate.
      // Set your own client-side timeout shorter than this (2-3s) to
      // actually observe a client timeout against this scenario.
      const ms = TIMEOUT_MIN_MS + Math.random() * (TIMEOUT_MAX_MS - TIMEOUT_MIN_MS);
      await delay(ms);
    } else if (outcome === 'latency') {
      const ms = LATENCY_MIN_MS + Math.random() * (LATENCY_MAX_MS - LATENCY_MIN_MS);
      await delay(ms);
    }

    let statusCode;
    let body;
    if (outcome === 'decline') {
      statusCode = 200;
      body = {
        paymentId,
        referenceId: payload.referenceId,
        amount: payload.amount,
        status: 'DECLINED',
        reason: 'INSUFFICIENT_FUNDS',
      };
    } else {
      statusCode = 201;
      body = { paymentId, referenceId: payload.referenceId, amount: payload.amount, status: 'APPROVED' };
    }

    completed.set(idempotencyKey, { requestHash, statusCode, body });
    byPaymentId.set(paymentId, { statusCode, body });

    if (!res.writableEnded) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
  } finally {
    inFlight.delete(idempotencyKey);
  }
}

function handleGetPayment(res, paymentId) {
  const record = byPaymentId.get(paymentId);
  if (!record) {
    return sendJson(res, 404, { error: 'PAYMENT_NOT_FOUND', message: `No payment found for id ${paymentId}.` });
  }
  sendJson(res, 200, record.body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'UP' });
  }

  if (req.method === 'POST' && url.pathname === '/payments') {
    return handleCreatePayment(req, res).catch((err) => {
      console.error(err);
      if (!res.writableEnded) sendJson(res, 500, { error: 'INTERNAL_ERROR', message: String(err) });
    });
  }

  const paymentMatch = url.pathname.match(/^\/payments\/([^/]+)$/);
  if (req.method === 'GET' && paymentMatch) {
    return handleGetPayment(res, paymentMatch[1]);
  }

  sendJson(res, 404, { error: 'NOT_FOUND', message: `${req.method} ${url.pathname} is not a route on this mock.` });
});

server.listen(PORT, () => {
  console.log(`mock-payment-api listening on :${PORT}`);
  console.log(`rates: ${JSON.stringify(RATES)}`);
});
