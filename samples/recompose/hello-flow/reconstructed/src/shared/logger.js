const createLogger = ({ name, handlers = [] } = {}) => {
  const sanitize = (msg) => msg?.trim() || '[empty]';
  const format = (severity, payload) => ({
    timestamp: new Date().toISOString(),
    severity,
    message: sanitize(payload.message),
    metadata: payload.metadata || {}
  });
  return {
    log: (payload) => handlers.forEach(h => h(format('info', payload))),
    warn: (payload) => handlers.forEach(h => h(format('warn', payload))),
    error: (payload) => handlers.forEach(h => h(format('error', payload)))
  };
};

module.exports = { createLogger };
