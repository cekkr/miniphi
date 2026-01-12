const { greet } = require('../../greeter');
const { average, trend } = require('../../math');
const { log } = require('../../logger');
const { store } = require('../../memory-store');

function validate(input) {
  const { name, samples } = input;

  // Sanitize input
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid name');
  }

  if (!samples || !Array.isArray(samples) || samples.length === 0) {
    throw new Error('Insufficient samples');
  }

  // Coordinate helper utilities
  const greeting = greet(name);
  const avg = average(samples);
  const description = trend(avg);

  // Emit structured results/logs
  log({ type: 'validation', data: { name, samples, avg, description } });
  store('validation-result', { name, samples, avg, description });

  return {
    greeting,
    average: avg,
    trend: description
  };
}

module.exports = { validate };
