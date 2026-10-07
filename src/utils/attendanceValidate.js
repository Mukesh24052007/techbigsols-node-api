function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function finiteNumber(value, name) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw httpError(400, `${name} must be a finite number.`);
  }
  return n;
}

function assertLatLngAccuracy(body) {
  const lat = finiteNumber(body.lat, 'lat');
  const lng = finiteNumber(body.lng, 'lng');
  const accuracy = finiteNumber(body.accuracy, 'accuracy');
  if (lat < -90 || lat > 90) throw httpError(400, 'lat must be between -90 and 90.');
  if (lng < -180 || lng > 180) throw httpError(400, 'lng must be between -180 and 180.');
  if (accuracy < 0) throw httpError(400, 'accuracy must be 0 or greater.');
  return { lat, lng, accuracy };
}

function assertDescriptor(arr, label) {
  if (!Array.isArray(arr) || arr.length !== 128) {
    throw httpError(400, `${label} must be an array of 128 numbers.`);
  }
  const out = new Array(128);
  for (let i = 0; i < 128; i += 1) {
    const n = typeof arr[i] === 'number' ? arr[i] : Number(arr[i]);
    if (!Number.isFinite(n)) {
      throw httpError(400, `${label}[${i}] must be a finite number.`);
    }
    if (Math.abs(n) > 10) {
      throw httpError(400, `${label} contains an out-of-range value.`);
    }
    out[i] = n;
  }
  return out;
}

function assertDescriptors(value, count, label = 'descriptors') {
  if (!Array.isArray(value) || value.length !== count) {
    throw httpError(400, `${label} must contain exactly ${count} arrays.`);
  }
  return value.map((item, i) => assertDescriptor(item, `${label}[${i}]`));
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    const parts = xf.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      const hopsSetting = parseInt(process.env.TRUSTED_PROXY_HOPS, 10);
      const hops = Number.isFinite(hopsSetting) && hopsSetting > 0 ? hopsSetting : 1;
      const idx = Math.max(0, parts.length - hops);
      return parts[idx].slice(0, 45);
    }
  }
  const ip = req.socket?.remoteAddress || req.ip || '';
  return String(ip).slice(0, 45);
}

function parseMonth(value) {
  if (!value || !/^\d{4}-\d{2}$/.test(String(value))) {
    throw httpError(400, 'month must be YYYY-MM.');
  }
  const [y, m] = String(value).split('-').map(Number);
  if (m < 1 || m > 12) throw httpError(400, 'month must be YYYY-MM.');
  return { year: y, month: m };
}

function parseIsoDate(value, name = 'date') {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw httpError(400, `${name} must be YYYY-MM-DD.`);
  }
  return String(value);
}

function validateOfficeInput(body, isUpdate = false) {
  if (!body || typeof body !== 'object') {
    throw httpError(400, 'Request body is required.');
  }

  const out = {};

  if (!isUpdate || body.name !== undefined) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      throw httpError(400, 'name is required and must be a non-empty string.');
    }
    if (body.name.trim().length > 100) {
      throw httpError(400, 'name must be at most 100 characters.');
    }
    out.name = body.name.trim();
  }

  if (!isUpdate || body.lat !== undefined) {
    const lat = finiteNumber(body.lat, 'lat');
    if (lat < -90 || lat > 90) throw httpError(400, 'lat must be between -90 and 90.');
    out.lat = lat;
  }

  if (!isUpdate || body.lng !== undefined) {
    const lng = finiteNumber(body.lng, 'lng');
    if (lng < -180 || lng > 180) throw httpError(400, 'lng must be between -180 and 180.');
    out.lng = lng;
  }

  if (!isUpdate || body.radius_m !== undefined) {
    const radius = finiteNumber(body.radius_m != null ? body.radius_m : 150, 'radius_m');
    if (radius < 20 || radius > 2000) throw httpError(400, 'radius_m must be between 20 and 2000.');
    out.radius_m = Math.round(radius);
  }

  if (!isUpdate || body.accuracy_max_m !== undefined) {
    const acc = finiteNumber(body.accuracy_max_m != null ? body.accuracy_max_m : 50, 'accuracy_max_m');
    if (acc < 10 || acc > 200) throw httpError(400, 'accuracy_max_m must be between 10 and 200.');
    out.accuracy_max_m = Math.round(acc);
  }

  if (body.outside_tolerance_minutes !== undefined) {
    const tol = finiteNumber(body.outside_tolerance_minutes, 'outside_tolerance_minutes');
    if (tol < 1 || tol > 120) throw httpError(400, 'outside_tolerance_minutes must be between 1 and 120.');
    out.outside_tolerance_minutes = Math.round(tol);
  }

  if (body.short_outing_allowance_minutes !== undefined) {
    const allow = finiteNumber(body.short_outing_allowance_minutes, 'short_outing_allowance_minutes');
    if (allow < 0 || allow > 240) throw httpError(400, 'short_outing_allowance_minutes must be between 0 and 240.');
    out.short_outing_allowance_minutes = Math.round(allow);
  }

  if (body.heartbeat_seconds !== undefined) {
    const hb = finiteNumber(body.heartbeat_seconds, 'heartbeat_seconds');
    if (hb < 10 || hb > 300) throw httpError(400, 'heartbeat_seconds must be between 10 and 300.');
    out.heartbeat_seconds = Math.round(hb);
  }

  if (body.reverify_count !== undefined) {
    const rev = finiteNumber(body.reverify_count, 'reverify_count');
    if (rev < 0 || rev > 10) throw httpError(400, 'reverify_count must be between 0 and 10.');
    out.reverify_count = Math.round(rev);
  }

  if (body.grace_minutes !== undefined) {
    const grace = finiteNumber(body.grace_minutes, 'grace_minutes');
    if (grace < 0 || grace > 60) throw httpError(400, 'grace_minutes must be between 0 and 60.');
    out.grace_minutes = Math.round(grace);
  }

  if (body.shift_start !== undefined) {
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(String(body.shift_start))) {
      throw httpError(400, 'shift_start must be HH:mm or HH:mm:ss.');
    }
    out.shift_start = String(body.shift_start).length === 5 ? `${body.shift_start}:00` : String(body.shift_start);
  }

  if (body.shift_end !== undefined) {
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(String(body.shift_end))) {
      throw httpError(400, 'shift_end must be HH:mm or HH:mm:ss.');
    }
    out.shift_end = String(body.shift_end).length === 5 ? `${body.shift_end}:00` : String(body.shift_end);
  }

  if (body.ip_allowlist !== undefined) {
    out.ip_allowlist = Array.isArray(body.ip_allowlist) ? body.ip_allowlist : null;
  }

  if (body.require_both !== undefined) {
    out.require_both = Boolean(body.require_both);
  }

  return out;
}

module.exports = {
  httpError,
  finiteNumber,
  assertLatLngAccuracy,
  assertDescriptors,
  clientIp,
  parseMonth,
  parseIsoDate,
  validateOfficeInput,
};
