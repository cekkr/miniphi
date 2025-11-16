import { createLogger } from "../shared/logger.js";
import MemoryStore from "../shared/persistence/memory-store.js";
import normalizeBatch from "./steps/normalize.js";
import validateBatch from "./steps/validate.js";

export default class InsightPipeline {
  constructor({ loggerFactory = createLogger, store = new MemoryStore() } = {}) {
    this.loggerFactory = loggerFactory;
    this.store = store;
  }

  process(values, context = {}) {
    const logger = this.loggerFactory("InsightPipeline");
    const validation = validateBatch(values, logger);
    const baseRecord = this.store.create({
      context,
      status: validation.ok ? "validated" : "rejected",
    });

    if (!validation.ok) {
      const metadata = {
        owner: context.owner ?? "anonymous",
        batchLabel: context.label ?? "n/a",
        count: 0,
        status: "rejected",
        issues: validation.reasons,
      };
      this.store.update(baseRecord.id, {
        metadata,
        log: logger.flush(),
      });
      return { normalized: [], metadata, id: baseRecord.id };
    }

    const { normalized, stats } = normalizeBatch(validation.values, logger);
    const metadata = {
      owner: context.owner ?? "anonymous",
      batchLabel: context.label ?? `batch-${baseRecord.id}`,
      count: normalized.length,
      status: "normalized",
      stats,
    };
    this.store.update(baseRecord.id, {
      metadata,
      normalized,
      log: logger.flush(),
    });
    return { normalized, metadata, id: baseRecord.id };
  }

  finalize(runId, summary = {}) {
    const record = this.store.update(runId, {
      summary: {
        ...summary,
        finalizedAt: new Date().toISOString(),
      },
    });
    if (!record) {
      return { runId, logLine: `No snapshot for ${runId}` };
    }
    const label = record.metadata?.batchLabel ?? "batch";
    const descriptor = `${summary.average ?? "n/a"} avg, trend ${summary.trend ?? "unknown"}`;
    return {
      runId: record.id,
      logLine: `Logged ${label} as ${record.id} (${descriptor})`,
    };
  }

  describeLastRun() {
    const last = this.store.last();
    if (!last) {
      return "No prior runs recorded.";
    }
    const owner = last.metadata?.owner ?? "anonymous";
    const count = last.metadata?.count ?? 0;
    const trend = last.summary?.trend ?? "unknown";
    return `Latest run #${last.id} by ${owner} tracked ${count} samples (trend ${trend}).`;
  }

  lastSnapshot() {
    return this.store.last();
  }
}
