export function validateStep(data, telemetry) {
  // Sanitize input
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid data provided');
  }

  const { name } = data;
  if (!name || typeof name !== 'string') {
    throw new Error('Name must be a non-empty string');
  }

  // Coordinate helper utilities
  console.log(`Processing validation for: ${name}`);

  // Handle edge cases (insufficient samples, missing state)
  if (!telemetry || !Array.isArray(telemetry)) {
    throw new Error('Telemetry must be an array');
  }

  return {
    validatedData: data,
    telemetryEvents: telemetry.map(event => ({
      ...event,
      timestamp: Date.now()
    }))
  };
}
