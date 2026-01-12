const average = (data) => {
  if (!Array.isArray(data)) return null;
  const filtered = data.filter(d => typeof d === 'number' && !isNaN(d));
  if (filtered.length < 2) return null;
  return filtered.reduce((sum, val) => sum + val, 0) / filtered.length;
};

const describeTrend = (avg, prevAvg) => {
  if (typeof avg !== 'number' || isNaN(avg)) return 'unknown';
  if (prevAvg === undefined) return 'stable';
  const diff = avg - prevAvg;
  if (diff > 0.1 * Math.abs(prevAvg)) return 'increasing';
  if (diff < -0.1 * Math.abs(prevAvg)) return 'decreasing';
  return 'stable';
};

module.exports = { average, describeTrend };
