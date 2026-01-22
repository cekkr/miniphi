const { sanitizeName } = require('../../helpers/sanitize');
const { logTelemetry } = require('../../utils/logger');

function normalize(input) {
  const { name, samples } = input;

  // Handle nullish names
  if (!name || name.trim() === '') {
    logTelemetry({ step: 'normalize', status: 'warn', message: 'Nullish name detected' });
    return { name: 'Unknown', samples: [] };
  }

  // Handle insufficient samples
  if (!samples || samples.length < 1) {
    logTelemetry({ step: 'normalize', status: 'warn', message: 'Insufficient samples' });
    return { name: sanitizeName(name), samples: [] };
  }

  // Sanitize and shape data
  const normalized = {
    name: sanitizeName(name),
    samples: samples.map(sample => ({ value: sample, timestamp: Date.now() }))
  };

  logTelemetry({ step: 'normalize', status: 'success', input, output: normalized });
  return normalized;
}

module.exports = { normalize };
