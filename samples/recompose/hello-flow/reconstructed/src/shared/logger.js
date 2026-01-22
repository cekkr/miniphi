export function createLogger(scope = "flow") {
  const history = [];

  const write = (level, message, metadata = {}) => {
    const entry = {
      scope,
      level,
      message,
      metadata,
      timestamp: new Date().toISOString()
    };

    history.push(entry);
    return entry;
  };

  return {
    info: (message, metadata) => write("info", message, metadata),
    warn: (message, metadata) => write("warn", message, metadata),
    error: (message, metadata) => write("error", message, metadata),
    flush: () => [...history]
  };
}
