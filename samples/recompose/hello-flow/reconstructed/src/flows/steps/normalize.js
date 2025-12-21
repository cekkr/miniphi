export function normalize(data, metadata = {}) {
  const sanitizedData = sanitizeInput(data);
  if (!sanitizedData) return null;
  const result = coordinateHelpers(sanitizedData, metadata);
  emitTelemetry(result, 'normalize');
  return validateResult(result);
}

function sanitizeInput(input) {
  if (!input || typeof input !== 'object') return null;
  return Object.keys(input).length ? input : null;
}

function coordinateHelpers(data, meta) {
  const { name } = meta;
  if (!name) throw new Error('Missing required metadata: name');
  const greeting = greet(name);
  const stats = computeStats(data.values || []);
  return { ...data, greeting, stats };
}

function emitTelemetry(payload, stepName) {
  logger.write({ step: stepName, payload });
}

function validateResult(result) {
  if (!result.stats?.average !== undefined) {
    throw new Error('Invalid computed statistics');
  }
  return result;
}
