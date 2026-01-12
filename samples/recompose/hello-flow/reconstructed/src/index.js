import { greet } from './greeter.js';
import { average, describeTrend } from './math.js';
import InsightPipeline from './flows/pipeline.js';

const pipeline = new InsightPipeline();

/**
 * Sanitizes input data and coordinates helper utilities.
 * @param {Object} params - Input parameters.
 * @param {string[]} params.names - Array of names.
 * @param {number[]} params.samples - Array of samples.
 * @returns {Object} Structured results with greetings, averages, and trends.
 */
export function summarize({ names = [], samples = [] }) {
  const sanitizedNames = names.filter(name => name != null && name.trim() !== '');
  const sanitizedSamples = samples.filter(sample => sample != null && !isNaN(sample));

  if (sanitizedNames.length === 0 || sanitizedSamples.length < 2) {
    return { greetings: [], average: null, trend: 'insufficient data' };
  }

  const results = pipeline({
    names: sanitizedNames,
    samples: sanitizedSamples
  });

  return {
    greetings: sanitizedNames.map(name => greet(name)),
    average: average(sanitizedSamples),
    trend: describeTrend(sanitizedSamples)
  };
}

/**
 * Generates a closing remark based on input data.
 * @param {Object} params - Input parameters.
 * @param {string[]} params.names - Array of names.
 * @returns {string} Closing remark.
 */
export function closingRemark({ names = [] }) {
  const sanitizedNames = names.filter(name => name != null && name.trim() !== '');
  return sanitizedNames.length > 0
    ? `Goodbye, ${sanitizedNames.join(', ')}!`
    : 'Goodbye!';
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const sampleValues = [1, 3, 5, 7];
  console.log(summarize({ names: ['MiniPhi'], samples: sampleValues }));
  console.log(summarize({ names: ['Ops Team'], samples: [2, 6, 11, 13, 21] }));
  console.log(closingRemark({ names: ['MiniPhi'] }));
}
