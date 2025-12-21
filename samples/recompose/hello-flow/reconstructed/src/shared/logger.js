const createLogger = (options = {}) => {
  const name = options.name || 'default';
  const level = validateLevel(options.level) || 'info';
  const format = typeof options.format === 'function' ? options.format : defaultFormat;

  return {
    info: (message) => log(level, 'info', message, { name, timestamp: new Date() }),
    warn: (message) => log(level, 'warn', message, { name, timestamp: new Date() }),
    error: (message) => log(level, 'error', message, { name, timestamp: new Date() }),
    debug: (message) => level === 'debug' && log(level, 'debug', message, { name, timestamp: new Date() })
  };
}

function validateLevel(level) {
  const validLevels = ['info', 'warn', 'error', 'debug'];
  return validLevels.includes(level) ? level : null;
}

function defaultFormat(message, metadata) {
  return JSON.stringify({
    message,
    ...metadata,
    timestamp: metadata.timestamp.toISOString()
  });
}

function log(currentLevel, severity, message, metadata) {
  if (severity === 'debug' && currentLevel !== 'debug') return;
  const output = defaultFormat(message, metadata);
  console[severity](output);
}

export { createLogger };
