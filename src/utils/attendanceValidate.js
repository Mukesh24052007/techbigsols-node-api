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

module.exports = {
  httpError,
  finiteNumber,
  assertLatLngAccuracy,
  assertDescriptors,
  clientIp,
  parseMonth,
  parseIsoDate,
};
