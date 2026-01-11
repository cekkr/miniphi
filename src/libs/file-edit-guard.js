import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const DEFAULT_ENCODING = "utf8";
const ROLLBACK_LABEL_FALLBACK = "file";
const MAX_LABEL_LENGTH = 160;

const normalizeContent = (content) => {
  if (content === null || content === undefined) {
    return "";
  }
  return typeof content === "string" ? content : String(content);
};

const hashText = (text) => createHash("sha256").update(text ?? "", "utf8").digest("hex");

const sanitizeRollbackLabel = (label) => {
  const raw = (label ?? ROLLBACK_LABEL_FALLBACK).toString();
  const sanitized = raw
    .replace(/[\\/]+/g, "__")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!sanitized) {
    return ROLLBACK_LABEL_FALLBACK;
  }
  return sanitized.length > MAX_LABEL_LENGTH ? sanitized.slice(0, MAX_LABEL_LENGTH) : sanitized;
};

const readFileIfExists = async (targetPath, encoding) => {
  try {
    const content = await fs.promises.readFile(targetPath, encoding);
    return { content, exists: true };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { content: null, exists: false };
    }
    throw error;
  }
};

const describeError = (error) => (error instanceof Error ? error.message : String(error));

const attemptRollback = async ({ targetPath, rollbackPath, beforeContent, encoding }) => {
  if (rollbackPath) {
    try {
      await fs.promises.copyFile(rollbackPath, targetPath);
      return { applied: true, source: rollbackPath };
    } catch (error) {
      return { applied: false, error: describeError(error) };
    }
  }
  if (beforeContent !== null && beforeContent !== undefined) {
    try {
      await fs.promises.writeFile(targetPath, beforeContent, encoding);
      return { applied: true, source: "memory" };
    } catch (error) {
      return { applied: false, error: describeError(error) };
    }
  }
  return { applied: false, error: "no rollback source available" };
};

export async function writeFileWithGuard(options = {}) {
  const {
    targetPath,
    content,
    encoding = DEFAULT_ENCODING,
    expectedHash = null,
    rollbackDir = null,
    rollbackLabel = null,
    diffSummaryFn = null,
  } = options;

  if (!targetPath) {
    throw new Error("writeFileWithGuard requires a targetPath.");
  }

  const normalizedContent = normalizeContent(content);
  const afterHash = hashText(normalizedContent);
  const { content: beforeContent, exists } = await readFileIfExists(targetPath, encoding);
  const beforeHash = beforeContent !== null ? hashText(beforeContent) : null;
  const diffSummary =
    typeof diffSummaryFn === "function" ? diffSummaryFn(beforeContent ?? "", normalizedContent) : null;

  if (expectedHash && beforeHash !== expectedHash) {
    return {
      status: "hash-mismatch",
      targetPath,
      beforeHash,
      afterHash,
      expectedHash,
      diffSummary,
    };
  }

  if (beforeHash && beforeHash === afterHash) {
    return {
      status: "unchanged",
      targetPath,
      beforeHash,
      afterHash,
      expectedHash,
      diffSummary,
    };
  }

  let rollbackPath = null;
  let rollbackError = null;
  if (exists && rollbackDir) {
    try {
      await fs.promises.mkdir(rollbackDir, { recursive: true });
      const label = sanitizeRollbackLabel(rollbackLabel ?? path.basename(targetPath));
      const rollbackName = `${label}.${Date.now()}.rollback`;
      const candidate = path.join(rollbackDir, rollbackName);
      await fs.promises.copyFile(targetPath, candidate);
      rollbackPath = candidate;
    } catch (error) {
      rollbackError = describeError(error);
    }
  }

  try {
    await fs.promises.writeFile(targetPath, normalizedContent, encoding);
  } catch (error) {
    const rollbackResult = await attemptRollback({
      targetPath,
      rollbackPath,
      beforeContent,
      encoding,
    });
    return {
      status: rollbackResult.applied ? "rollback" : "failed",
      targetPath,
      beforeHash,
      afterHash,
      expectedHash,
      diffSummary,
      rollbackPath,
      rollbackError,
      error: describeError(error),
      rollbackStatus: rollbackResult,
    };
  }

  try {
    const verification = await fs.promises.readFile(targetPath, encoding);
    const verifyHash = hashText(verification);
    if (verifyHash !== afterHash) {
      const rollbackResult = await attemptRollback({
        targetPath,
        rollbackPath,
        beforeContent,
        encoding,
      });
      return {
        status: rollbackResult.applied ? "rollback" : "failed",
        targetPath,
        beforeHash,
        afterHash,
        expectedHash,
        diffSummary,
        rollbackPath,
        rollbackError,
        error: "Write verification failed: hash mismatch.",
        rollbackStatus: rollbackResult,
      };
    }
  } catch (error) {
    const rollbackResult = await attemptRollback({
      targetPath,
      rollbackPath,
      beforeContent,
      encoding,
    });
    return {
      status: rollbackResult.applied ? "rollback" : "failed",
      targetPath,
      beforeHash,
      afterHash,
      expectedHash,
      diffSummary,
      rollbackPath,
      rollbackError,
      error: describeError(error),
      rollbackStatus: rollbackResult,
    };
  }

  return {
    status: "written",
    targetPath,
    beforeHash,
    afterHash,
    expectedHash,
    diffSummary,
    rollbackPath,
    rollbackError,
  };
}
