const { greet } = require('../../greeter');
const { average } = require('../../math');

function normalize(data, metadata = {}) {
  const { name = 'Guest', samples = [] } = data;
  
  if (!name || typeof name !== 'string') {
    console.warn('Nullish or invalid name detected. Using default.');
    return { name: 'Guest', average: null, telemetry: { warning: 'default_name_used' } };
  }
  
  if (samples.length < 1) {
    console.warn('Insufficient samples provided.');
    return { name, average: null, telemetry: { warning: 'insufficient_samples' } };
  }
  
  const avg = average(samples);
  const result = { name, average: avg, telemetry: { processed: true } };
  console.log(`Processed ${name} with average ${avg}`);
  
  return result;
}

module.exports = { normalize };
