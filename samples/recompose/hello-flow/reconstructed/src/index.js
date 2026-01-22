import { greet } from './greeter.js';
import { average, trend } from './math.js';
import { pipeline } from './flows/pipeline.js';
/**
 * @param {Object} input - Raw input data
 * @param {string[]} [input.names] - List of names
 * @param {number[]} [input.numbers] - List of numbers
 */
export function summarize(input) {
  const { names = [], numbers = [] } = input || {};
  
  // Sanitize inputs
  const sanitizedNames = names.filter(name => name != null);
  const sanitizedNumbers = numbers.filter(n => n != null && !isNaN(n));
  
  // Coordinate helper utilities
  const greeting = greet(sanitizedNames[0] || 'Guest');
  const avg = average(sanitizedNumbers);
  const description = trend(avg, sanitizedNumbers.length);
  
  // Emit structured results
  return {
    greeting,
    average: avg,
    trend: description,
    sampleSize: sanitizedNumbers.length
  };
}

/**
 * @param {string} name - Name for farewell
 */
export function closingRemark(name) {
  if (!name) return 'Goodbye, Guest!';
  return greet(name, true);
}
