const assert = require('assert');
const { euclideanDistance, averageDescriptors, matchThreshold } = require('../src/utils/faceMath');

// Generate a deterministic 128-dimensional synthetic face descriptor
const baseDescriptor = [];
for (let i = 0; i < 128; i++) {
  baseDescriptor.push(Math.sin(i * 0.1) * 0.1);
}

// Generate 5 slightly noisy copies of the descriptor (camera capture noise)
const noisyCopies = [];
for (let frame = 0; frame < 5; frame++) {
  const noisy = baseDescriptor.map((val, idx) => {
    const noise = Math.sin((frame + 1) * (idx + 1)) * 0.005;
    return val + noise;
  });
  noisyCopies.push(noisy);
}

// Average the 5 enrolment descriptors (unnormalized mean)
const enrolledTemplate = averageDescriptors(noisyCopies);

// Calculate Euclidean distance between base descriptor and the template
const dist = euclideanDistance(baseDescriptor, enrolledTemplate);
console.log(`Computed Euclidean distance to template: ${dist.toFixed(6)}`);

const threshold = matchThreshold();
console.log(`Configured match threshold: ${threshold}`);

// Assert distance is well under 0.5
assert(dist < 0.1, `Distance ${dist} should be well under 0.1`);
assert(dist < threshold, `Distance ${dist} should be less than threshold ${threshold}`);

console.log('✅ Face math test passed: descriptor matches template made from 5 slightly noisy copies at distance well under 0.5.');
