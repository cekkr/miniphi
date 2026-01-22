const { normalize } = require('./normalize');
const { greet, farewell } = require('../../greeter');
const { average, trend } = require('../../math');
const { log } = require('../../utils/logger');

function validate(input) {
  const { name, samples } = input;

  // Sanitize input
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid name');
  }

  if (!samples || !Array.isArray(samples) || samples.length === 0) {
    throw new Error('Insufficient samples');
  }

  // Validate data integrity
  const normalized = normalize(input);

  // Coordinate with helper utilities
  const avg = average(normalized.samples);
  const description = trend(avg);

  // Emit structured telemetry logs
  log('info', { step: 'validate', name, samples });

  return {
    name,
    samples,
    avg,
    description,
    timestamp: new Date().toISOString()
  };
}

module.exports = { validate };
