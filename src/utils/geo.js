const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance in metres (haversine).
 */
function haversineMetres(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function parseIpAllowlist(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.map(String).map((s) => s.trim()).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Server-side check-in / heartbeat gate.
 * GPS must be inside radius AND accuracy within max, unless an IP allowlist
 * is configured: then GPS OR IP (or both when office.require_both).
 *
 * @returns {{ ok: boolean, reason: string|null, gpsOk: boolean, ipOk: boolean, distanceM: number }}
 */
function evaluateLocation({ office, lat, lng, accuracy, ip }) {
  const radius = Number(office.radius_m) || 150;
  const accuracyMax = Number(office.accuracy_max_m) || 50;
  const distanceM = haversineMetres(
    Number(lat),
    Number(lng),
    Number(office.lat),
    Number(office.lng)
  );
  const accuracyOk = Number(accuracy) <= accuracyMax;
  const inside = distanceM <= radius;
  const gpsOk = accuracyOk && inside;

  const allowlist = parseIpAllowlist(office.ip_allowlist);
  const ipConfigured = allowlist.length > 0;
  const ipOk = ipConfigured && ip && allowlist.includes(String(ip).trim());

  if (!ipConfigured) {
    if (!accuracyOk) {
      return { ok: false, reason: `GPS accuracy must be ${accuracyMax} m or better.`, gpsOk, ipOk: false, distanceM };
    }
    if (!inside) {
      return { ok: false, reason: 'You are outside the office radius.', gpsOk, ipOk: false, distanceM };
    }
    return { ok: true, reason: null, gpsOk, ipOk: false, distanceM };
  }

  const requireBoth = Boolean(office.require_both);
  const ok = requireBoth ? gpsOk && ipOk : gpsOk || ipOk;
  if (ok) return { ok: true, reason: null, gpsOk, ipOk, distanceM };

  if (requireBoth) {
    return { ok: false, reason: 'Office location and allowed network are both required.', gpsOk, ipOk, distanceM };
  }
  if (!accuracyOk && !ipOk) {
    return { ok: false, reason: `GPS accuracy must be ${accuracyMax} m or better.`, gpsOk, ipOk, distanceM };
  }
  return { ok: false, reason: 'You are outside the office radius and not on an allowed network.', gpsOk, ipOk, distanceM };
}

module.exports = {
  haversineMetres,
  parseIpAllowlist,
  evaluateLocation,
};
