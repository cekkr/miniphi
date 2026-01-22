const average = (data) => {
  if (!Array.isArray(data)) return null;
  const filtered = data.filter(d => d != null);
  if (filtered.length === 0) return null;
  const sum = filtered.reduce((acc, val) => acc + val, 0);
  return sum / filtered.length;
};

const describeTrend = (avg, samples) => {
  if (samples < 2) return 'Insufficient samples';
  if (avg === null) return 'No trend data';
  if (avg > 0.7) return 'Strong upward trend';
  if (avg > 0.3) return 'Moderate upward trend';
  if (avg < -0.3) return 'Moderate downward trend';
  return 'Stable trend';
};

module.exports = { average, describeTrend };
