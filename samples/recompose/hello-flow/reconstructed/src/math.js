const average = (data) => {
  if (!Array.isArray(data)) return null;
  const filtered = data.filter(d => typeof d === 'number' && !isNaN(d));
  if (filtered.length === 0) return null;
  return filtered.reduce((sum, val) => sum + val, 0) / filtered.length;
};

const describeTrend = (data) => {
  const avg = average(data);
  if (avg === null || data.length < 2) return 'stable';
  const first = data[0];
  const last = data[data.length - 1];
  if (last > first * 1.1) return 'increasing';
  if (last < first * 0.9) return 'decreasing';
  return 'stable';
};

module.exports = { average, describeTrend };
