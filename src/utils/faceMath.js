function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function averageDescriptors(list) {
  const dim = 128;
  const acc = new Array(dim).fill(0);
  for (const item of list) {
    for (let i = 0; i < dim; i += 1) acc[i] += item[i];
  }
  const n = list.length;
  const avg = acc.map((v) => v / n);
  let norm = 0;
  for (const v of avg) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) avg[i] /= norm;
  }
  return avg;
}

function descriptorsIdentical(list, eps = 1e-5) {
  for (let i = 1; i < list.length; i += 1) {
    if (euclideanDistance(list[0], list[i]) < eps) return true;
  }
  for (let i = 1; i < list.length - 1; i += 1) {
    if (euclideanDistance(list[i], list[i + 1]) < eps) return true;
  }
  return false;
}

function matchThreshold() {
  const n = Number(process.env.FACE_MATCH_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

module.exports = {
  euclideanDistance,
  averageDescriptors,
  descriptorsIdentical,
  matchThreshold,
};
