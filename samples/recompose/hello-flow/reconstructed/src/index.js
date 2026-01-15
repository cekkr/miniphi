import { greet, farewell } from './greeter.js';
import { average, trend } from './math.js';
import { pipeline } from './flows/pipeline.js';

/**
 * @param {Object} input - User input object
 * @param {string} input.name - User's name
 * @param {Array<number>} input.data - Data samples
 */
export function summarize(input) {
  const { name, data } = input;
  
  // Sanitize input
  if (!name || !data || data.length === 0) {
    throw new Error('Invalid input: name and non-empty data are required');
  }
  
  // Coordinate helper utilities
  const welcomeMessage = greet(name);
  const stats = {
    average: average(data),
    trend: trend(data)
  };
  
  // Emit structured results/logs
  console.log(`[Telemetry] Processed data for ${name}:`, stats);
  
  return {
    welcomeMessage,
    ...stats
  };
}

export function closingRemark(input) {
  const { name, data } = input;
  
  // Handle edge cases
  if (!name || !data || data.length < 2) {
    return farewell(name || 'user');
  }
  
  const stats = {
    average: average(data),
    trend: trend(data)
  };
  
  console.log(`[Telemetry] Closing remark for ${name}:`, stats);
  
  return `${farewell(name)}. Summary: avg=${stats.average}, trend=${stats.trend}`;
}
