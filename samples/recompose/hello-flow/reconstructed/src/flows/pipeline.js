import { logger } from '../shared/logger.js';
import { memoryStore } from '../shared/persistence/memory-store.js';
import { normalize } from './steps/normalize.js';
import { validate } from './steps/validate.js';

class InsightPipeline {
  constructor() {
    this.logger = logger;
    this.store = memoryStore;
  }

  async process(data) {
    try {
      // Step 1: Normalize input
      const normalized = normalize(data);
      this.logger.write('info', 'Input normalized');

      // Step 2: Validate sanitized data
      const validated = validate(normalized);
      this.logger.write('info', 'Data validated');

      // Step 3: Persist state
      await this.store.set('state', validated);
      this.logger.write('info', 'State persisted');

      return validated;
    } catch (error) {
      this.logger.write('error', `Pipeline error: ${error.message}`);
      throw error;
    }
  }
}

export const pipeline = new InsightPipeline();
