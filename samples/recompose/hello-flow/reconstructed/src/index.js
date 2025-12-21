import { greet, farewell } from './greeter.js';
import { average, trend } from './math.js';
import { pipeline } from './flows/pipeline.js';

/**
 * Sanitizes input and coordinates helper utilities.
 * @param {Object} input - Input object with name and samples.
 * @returns {Object} Summarized results.
 */
export function summarize(input) {
  const sanitized = sanitizeInput(input);
  const results = pipeline(sanitized);
  return results;
}

/**
 * Emits closing remarks based on input.
 * @param {Object} input - Input object with name and samples.
 */
export function closingRemark(input) {
  const sanitized = sanitizeInput(input);
  console.log(farewell(sanitized.name));
}

function sanitizeInput(input) {
  return {
    name: input?.name || 'Guest',
    samples: Array.isArray(input.samples) ? input.samples : []
  };
}
