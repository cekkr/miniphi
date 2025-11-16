export default function normalizeBatch(values, logger) {
  if (!Array.isArray(values) || values.length === 0) {
    return { normalized: [], stats: { min: 0, max: 0, spread: 0, center: 0 } };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const normalized = values.map((value) => Number(((value - min) / spread).toFixed(4)));
  const center = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const stats = {
    min,
    max,
    spread,
    center: Number(center.toFixed(4)),
  };
  logger.info("Normalization completed", stats);
  return { normalized, stats };
}
