const logger = require('../shared/logger');
const memoryStore = require('../shared/persistence/memory-store');
const normalize = require('./steps/normalize');
const validate = require('./steps/validate');

class InsightPipeline {
  constructor() {
    this.logger = logger;
    this.store = memoryStore;
  }

  async process(input) {
    try {
      const normalized = normalize(input);
      this.emitTelemetry('normalize', { input, output: normalized });

      if (!normalized || !validate(normalized)) {
        throw new Error('Validation failed');
      }

      this.emitTelemetry('validate', { input: normalized });

      const result = this.computeInsight(normalized);
      await this.store.save(result);

      return result;
    } catch (error) {
      this.logger.error('Pipeline error:', error);
      throw error;
    }
  }

  emitTelemetry(step, data) {
    const telemetry = { step, timestamp: new Date().toISOString(), ...data };
    this.logger.info('Telemetry', telemetry);
  }

  computeInsight(normalized) {
    return { insight: 'Processed successfully' };
  }
}

module.exports = InsightPipeline;
