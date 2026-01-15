import { createLogger } from '../shared/logger.js';
import { MemoryStore } from '../shared/persistence/memory-store.js';
import { normalize } from './steps/normalize.js';
import { validate } from './steps/validate.js';

class InsightPipeline {
  constructor() {
    this.logger = createLogger();
    this.store = new MemoryStore();
  }

  async process(data, metadata) {
    try {
      // Normalize input
      const normalizedData = normalize(data);
      
      // Validate normalized data
      const validatedData = validate(normalizedData);
      
      // Emit telemetry
      this.logger.log('info', 'Pipeline processed data', { metadata });
      
      // Persist results
      await this.store.save(validatedData);
      
      return { success: true, data: validatedData };
    } catch (error) {
      this.logger.log('error', 'Pipeline failed', { error: error.message });
      throw error;
    }
  }
}

export { InsightPipeline };
