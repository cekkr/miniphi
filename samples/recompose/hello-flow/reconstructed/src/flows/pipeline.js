const logger = require('../shared/logger');
const memoryStore = require('../shared/persistence/memory-store');
const normalize = require('./steps/normalize');
const validate = require('./steps/validate');

class InsightPipeline {
  constructor() {
    this.logger = logger;
    this.store = memoryStore;
  }

  async run(data, config) {
    const telemetry = { step: 'start', timestamp: Date.now(), data };
    this.logger.log(telemetry);

    try {
      const normalized = normalize(data);
      telemetry.step = 'normalize';
      this.logger.log(telemetry);

      const validated = validate(normalized, config);
      telemetry.step = 'validate';
      this.logger.log(telemetry);

      await this.store.save('last_result', validated);
      return { result: validated, telemetry };
    } catch (error) {
      telemetry.error = error.message;
      this.logger.log(telemetry);
      throw error;
    }
  }
}

module.exports = InsightPipeline;
