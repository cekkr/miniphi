"use strict";

function createLogger(scope = "flow") {
  const history = [];

  function log(level, message, metadata = {}) {
    let msg;
    if (message === undefined || message === null) {
      msg = "";
    } else if (typeof message === "string") {
      msg = message;
    } else {
      try {
        msg = JSON.stringify(message);
      } catch (e) {
        msg = "[non-string]";
      }
    }

    const entry = {
      scope,
      level,
      message: msg,
      metadata,
      timestamp: Date.now()
    };
    history.push(entry);
  }

  return {
    info(msg, meta = {}) {
      log("info", msg, meta);
    },
    warn(msg, meta = {}) {
      log("warn", msg, meta);
    },
    error(msg, meta = {}) {
      log("error", msg, meta);
    },
    flush() {
      // Return an immutable copy of the history array.
      return [...history];
    }
  };
}

module.exports = createLogger;
