const { greet } = require('../../greeter');
const { average, trend } = require('../../math');
function normalize(input) {
  const sanitized = input.trim();
  if (!sanitized) {
    return { status: 'normalized', data: null };
  }
  const avg = average(sanitized.split('').map(c => c.charCodeAt(0)));
  const description = trend(avg);
  return { status: 'normalized', data: sanitized, avg, description };
}
module.exports = { normalize };
