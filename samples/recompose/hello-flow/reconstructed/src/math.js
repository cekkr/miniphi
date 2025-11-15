export function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const numbers = values.map((value) => Number(value) || 0);
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return Number((total / numbers.length).toFixed(2));
}

export function describeTrend(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return "insufficient-data";
  }
  const diff = values[values.length - 1] - values[0];
  if (diff === 0) {
    return "flat";
  }
  return diff > 0 ? "upward" : "downward";
}
