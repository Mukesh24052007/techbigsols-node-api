'use strict';

require('dotenv').config();
const http = require('http');

let BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
let ephemeralServer = null;

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` (${detail})` : ''}`);
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const method = options.method || 'GET';
  const headers = options.headers || {};
  let body = options.body;
  if (body && typeof body === 'object') {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
  });

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => null);
  }

  return {
    status: res.status,
    headers: res.headers,
    data,
  };
}

function isLocalUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

async function checkServerReachable(urlStr) {
  try {
    const res = await fetch(`${urlStr}/health`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function runCorsRegressionTest() {
  console.log('\n--- Production CORS Regression Test ---');

  // Test with custom app instances to verify CORS configuration under both envs
  // 1. Production mode with default origins
  delete process.env.EXTRA_ALLOWED_ORIGINS;
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  // Clear require cache for app to reload with production NODE_ENV
  delete require.cache[require.resolve('../src/app')];
  const appProd = require('../src/app');
  const serverProd = http.createServer(appProd);
  await new Promise((r) => serverProd.listen(0, r));
  const prodUrl = `http://localhost:${serverProd.address().port}`;

  try {
    // a. https://techbigsolutions.in (allowed)
    const res1 = await fetch(`${prodUrl}/health`, {
      headers: { Origin: 'https://techbigsolutions.in' },
    });
    const allow1 = res1.headers.get('access-control-allow-origin');
    record(
      'CORS Prod: https://techbigsolutions.in is allowed',
      allow1 === 'https://techbigsolutions.in',
      `Header: ${allow1}`
    );

    // b. https://www.techbigsolutions.in (allowed)
    const res2 = await fetch(`${prodUrl}/health`, {
      headers: { Origin: 'https://www.techbigsolutions.in' },
    });
    const allow2 = res2.headers.get('access-control-allow-origin');
    record(
      'CORS Prod: https://www.techbigsolutions.in is allowed',
      allow2 === 'https://www.techbigsolutions.in',
      `Header: ${allow2}`
    );

    // c. http://localhost:3000 in production (must be blocked)
    let blockedLocal = false;
    try {
      const res3 = await fetch(`${prodUrl}/health`, {
        headers: { Origin: 'http://localhost:3000' },
      });
      const allow3 = res3.headers.get('access-control-allow-origin');
      blockedLocal = !allow3 || res3.status >= 400;
    } catch {
      blockedLocal = true;
    }
    record('CORS Prod: http://localhost:3000 is blocked in production', blockedLocal);

    // d. https://evil.example in production (must be blocked)
    let blockedEvil = false;
    try {
      const res4 = await fetch(`${prodUrl}/health`, {
        headers: { Origin: 'https://evil.example' },
      });
      const allow4 = res4.headers.get('access-control-allow-origin');
      blockedEvil = !allow4 || res4.status >= 400;
    } catch {
      blockedEvil = true;
    }
    record('CORS Prod: https://evil.example is blocked in production', blockedEvil);
  } finally {
    serverProd.close();
  }

  // 2. Development mode: localhost:3000 must be allowed
  process.env.NODE_ENV = 'development';
  delete require.cache[require.resolve('../src/app')];
  const appDev = require('../src/app');
  const serverDev = http.createServer(appDev);
  await new Promise((r) => serverDev.listen(0, r));
  const devUrl = `http://localhost:${serverDev.address().port}`;

  try {
    const resDev = await fetch(`${devUrl}/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    const allowDev = resDev.headers.get('access-control-allow-origin');
    record(
      'CORS Dev: http://localhost:3000 is allowed in development',
      allowDev === 'http://localhost:3000',
      `Header: ${allowDev}`
    );
  } finally {
    serverDev.close();
    process.env.NODE_ENV = originalEnv;
    delete require.cache[require.resolve('../src/app')];
  }
}

async function run() {
  console.log('=== TechBig Solutions Smoke Test ===');

  const isLocal = isLocalUrl(BASE_URL);
  const dbHost = (process.env.DB_HOST || '').toLowerCase();
  const isDbLocal = (dbHost === 'localhost' || dbHost === '127.0.0.1') && process.env.NODE_ENV !== 'production';

  // If local URL and server is not running on port, start ephemeral server on dynamic port
  let reachable = await checkServerReachable(BASE_URL);
  if (!reachable && isLocal) {
    console.log(`ℹ️  No server responding on ${BASE_URL}. Starting ephemeral instance on dynamic port...`);
    const app = require('../src/app');
    ephemeralServer = http.createServer(app);
    await new Promise((resolve) => ephemeralServer.listen(0, resolve));
    const port = ephemeralServer.address().port;
    BASE_URL = `http://localhost:${port}`;
    console.log(`ℹ️  Ephemeral instance running on ${BASE_URL}`);
  }

  const mode = isLocal && isDbLocal ? '[LOCAL FULL MODE]' : '[SAFE REMOTE MODE]';
  console.log(`\nMode: ${mode}`);
  console.log(`Target: ${BASE_URL}\n`);

  try {
    // ── 1. Root & Health Probes ──────────────────────────────────────────────
    console.log('--- 1. Health & Root Probes ---');
    {
      const res = await request('/');
      record('GET / returns 200', res.status === 200, `Status: ${res.status}`);
    }
    {
      const res = await request('/health');
      record('GET /health returns 200', res.status === 200, `Status: ${res.status}`);
    }
    {
      const res = await request('/api/health');
      record('GET /api/health returns 200', res.status === 200, `Status: ${res.status}`);
    }

    // ── 2. Core Auth Negative Checks ─────────────────────────────────────────
    console.log('\n--- 2. Core Auth Negative Checks ---');
    {
      const res = await request('/api/auth/login', {
        method: 'POST',
        body: { email: 'badadmin@techbigsols.com', password: 'wrongpassword' },
      });
      record('POST /api/auth/login bad credentials returns 401', res.status === 401, `Status: ${res.status}`);
    }
    {
      const res = await request('/api/site-auth/login', {
        method: 'POST',
        body: { email: 'baduser@techbigsols.com', password: 'wrongpassword' },
      });
      record('POST /api/site-auth/login bad credentials returns 401', res.status === 401, `Status: ${res.status}`);
    }

    // ── 3. Legacy Endpoints ──────────────────────────────────────────────────
    console.log('\n--- 3. Legacy Application Endpoints ---');
    {
      const res = await request('/api/products');
      record('GET /api/products returns 200', res.status === 200, `Status: ${res.status}`);
    }
    {
      const res = await request('/api/user-master');
      record('GET /api/user-master without token returns 401', res.status === 401, `Status: ${res.status}`);
    }

    // ── 4. Attendance Read-Only & Auth Barriers ──────────────────────────────
    console.log('\n--- 4. Attendance Module Probes & Auth Barriers ---');
    {
      const res = await request('/api/attendance/ping');
      record('GET /api/attendance/ping returns 200', res.status === 200, `Status: ${res.status}`);
    }
    {
      const res = await request('/api/attendance/me/status');
      record('GET /api/attendance/me/status without token returns 401', res.status === 401, `Status: ${res.status}`);
    }

    // Admin routes must all return 401 when accessed without token
    const adminRoutes = [
      { method: 'GET', path: '/api/attendance/admin/offices' },
      { method: 'POST', path: '/api/attendance/admin/offices', body: {} },
      { method: 'GET', path: '/api/attendance/admin/offices/1' },
      { method: 'PUT', path: '/api/attendance/admin/offices/1', body: {} },
      { method: 'DELETE', path: '/api/attendance/admin/offices/1' },
      { method: 'GET', path: '/api/attendance/admin/employees' },
      { method: 'PUT', path: '/api/attendance/admin/employees/tb001/profile', body: {} },
      { method: 'GET', path: '/api/attendance/admin/employees/tb001/timeline' },
      { method: 'GET', path: '/api/attendance/admin/live' },
      { method: 'GET', path: '/api/attendance/admin/stream' },
      { method: 'GET', path: '/api/attendance/admin/report?month=2026-10' },
      { method: 'GET', path: '/api/attendance/admin/attempts' },
      { method: 'GET', path: '/api/attendance/admin/regularizations' },
      { method: 'POST', path: '/api/attendance/admin/regularizations/1/approve', body: {} },
      { method: 'POST', path: '/api/attendance/admin/regularizations/1/reject', body: {} },
      { method: 'PATCH', path: '/api/attendance/admin/records/1', body: {} },
      { method: 'GET', path: '/api/attendance/admin/leaves' },
      { method: 'POST', path: '/api/attendance/admin/leaves', body: {} },
      { method: 'DELETE', path: '/api/attendance/admin/leaves/1' },
      { method: 'POST', path: '/api/attendance/admin/employees/tb001/face', body: {} },
      { method: 'DELETE', path: '/api/attendance/admin/employees/tb001/face' },
    ];

    let allAdminRoutesBlocked = true;
    for (const r of adminRoutes) {
      const res = await request(r.path, { method: r.method, body: r.body });
      if (res.status !== 401) {
        allAdminRoutesBlocked = false;
        record(`Admin Route ${r.method} ${r.path} without token`, false, `Expected 401, got ${res.status}`);
      }
    }
    if (allAdminRoutesBlocked) {
      record('All 21 Attendance Admin routes reject unauthenticated requests with 401', true);
    }

    // ── 5. CORS Regression Test ──────────────────────────────────────────────
    await runCorsRegressionTest();
  } catch (err) {
    console.error('Smoke test error:', err);
    record('Fatal smoke test exception', false, err.message);
  } finally {
    if (ephemeralServer) {
      ephemeralServer.close();
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  console.log(`\n========================================`);
  console.log(`Smoke Test Results: ${passed}/${total} passed (${failed} failed)`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

run();
