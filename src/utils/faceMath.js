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
  return acc.map((v) => v / n);
}

function minPairwiseDistance(list) {
  if (!Array.isArray(list) || list.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const d = euclideanDistance(list[i], list[j]);
      if (d < min) min = d;
    }
  }
  return min;
}

function replayEpsilon() {
  const n = Number(process.env.FACE_REPLAY_EPSILON);
  return Number.isFinite(n) && n > 0 ? n : 0.004;
}

function descriptorsIdentical(list, eps = replayEpsilon()) {
  return minPairwiseDistance(list) < eps;
}

function matchThreshold() {
  const n = Number(process.env.FACE_MATCH_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

module.exports = {
  euclideanDistance,
  averageDescriptors,
  minPairwiseDistance,
  replayEpsilon,
  descriptorsIdentical,
  matchThreshold,
};

