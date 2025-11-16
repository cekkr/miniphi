"use strict";

class Logger {
  constructor(scope = "flow") {
    this.scope = scope;
    // Internal storage for log history.
    this.logHistory = [];
    // Define the valid severity levels.
    this.validSeverities = ["info", "warn", "error"];
  }

  _validateSeverity(severity) {
    return this.validSeverities.includes(severity);
  }

  _sanitizeMessage(message) {
    if (message == null || message === "") {
      return "[No message provided]";
    }
    // Ensure the message is a trimmed string.
    return String(message).trim();
  }

  _normalizeMetadata(metadata = {}) {
    try {
      if (!metadata || typeof metadata !== "object") {
        return {};
      }
      const normalized = {};
      for (let key in metadata) {
        if (Object.prototype.hasOwnProperty.call(metadata, key) && metadata[key] != null) {
          normalized[key] = metadata[key];
        }
      }
      return normalized;
    } catch (error) {
      console.error("Error normalizing metadata:", error);
      return {};
    }
  }

  _getTimestamp() {
    try {
      // Generate a timestamp using the current date and time.
      return new Date().toISOString();
    } catch (error) {
      console.error("Error generating timestamp:", error);
      return "timestamp unavailable";
    }
  }

  _internalLog(severity, messageText, metadata) {
    if (!this._validateSeverity(severity)) {
      // Ignore the log entry if severity is invalid.
      console.warn(`Invalid severity level "${severity}" provided. Log entry ignored.`);
      return;
    }
    const sanitizedMessage = this._sanitizeMessage(messageText);
    const normalizedMetadata = this._normalizeMetadata(metadata);
    const timestamp = this._getTimestamp();

    // Construct the structured log entry.
    const logEntry = {
      severity,
      message: sanitizedMessage,
      metadata: normalizedMetadata,
      timestamp,
      scope: this.scope
    };

    // Append the entry to internal history immediately.
    this.logHistory.push(logEntry);
  }

  info(message, metadata) {
    this._internalLog("info", message, metadata);
  }

  warn(message, metadata) {
    this._internalLog("warn", message, metadata);
  }

  error(message, metadata) {
    this._internalLog("error", message, metadata);
  }

  flush() {
    // Return a copy of the accumulated log history.
    return [...this.logHistory];
  }
}

// Export the Logger module for use in different environments.
if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
  module.exports = Logger;
} else {
  window.Logger = Logger;
}
