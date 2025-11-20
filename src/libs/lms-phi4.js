import { Chat } from "@lmstudio/sdk";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import LMStudioManager from "./lmstudio-api.js";
import Phi4StreamParser from "./phi4-stream-parser.js";

const MODEL_KEY = "microsoft/Phi-4-reasoning-plus";
const DEFAULT_SYSTEM_PROMPT = [
  "You are MiniPhi, a local workspace agent.",
  "Inspect the provided workspace context (codebases, documentation hubs, or book-style markdown collections) and adapt your strategy accordingly.",
  "When the directory resembles a book or documentation set, provide a cohesive overview, suggest edits, and propose new sections/chapters when helpful.",
  "When the directory is code-heavy, act as an expert code engineer while still respecting any docs present.",
  "Always explain your reasoning, keep instructions actionable, and operate directly on the artifacts referenced in the prompt.",
].join(" ");

/**
 * Layer 2 handler that encapsulates Phi-4 specific behavior (system prompt, history management,
 * <think> parsing and streaming support). Relies on LMStudioManager for the actual model handles.
 */
export class Phi4Handler {
  /**
   * @param {LMStudioManager} manager
   * @param {{ systemPrompt?: string }} [options]
   */
  constructor(manager = new LMStudioManager(), options = undefined) {
    this.manager = manager;
    this.model = null;
    this.systemPrompt = options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.promptTimeoutMs =
      typeof options?.promptTimeoutMs === "number" && Number.isFinite(options.promptTimeoutMs)
        ? options.promptTimeoutMs
        : null;
    this.chatHistory = [{ role: "system", content: this.systemPrompt }];
    this.promptRecorder = options?.promptRecorder ?? null;
    this.performanceTracker = options?.performanceTracker ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
  }

  /**
   * Loads Phi-4 Reasoning Plus with the requested configuration (defaults to 32k context).
   * @param {import("@lmstudio/sdk").LLMLoadModelConfig} [config]
   */
  async load(config = undefined) {
    this.model = await this.manager.getModel(MODEL_KEY, {
      contextLength: 32768,
      ...(config ?? {}),
    });
  }

  /**
   * Ejects the Phi-4 model and resets history cache.
   */
  async eject() {
    await this.manager.ejectModel(MODEL_KEY);
    this.model = null;
    this.clearHistory();
  }

  /**
   * Resets the chat history while preserving the mandatory Phi system prompt.
   */
  clearHistory() {
    this.chatHistory = [{ role: "system", content: this.systemPrompt }];
  }

  /**
   * Allows downstream callers to start/stop prompt recording dynamically.
   * @param {import("./prompt-recorder.js").default | null} recorder
   */
  setPromptRecorder(recorder) {
    this.promptRecorder = recorder ?? null;
  }

  /**
   * Enables or disables the prompt performance tracker.
   * @param {import("./prompt-performance-tracker.js").default | null} tracker
   */
  setPerformanceTracker(tracker) {
    this.performanceTracker = tracker ?? null;
  }

  /**
   * Enables or disables schema validation for Phi exchanges.
   * @param {import("./prompt-schema-registry.js").default | null} registry
   */
  setSchemaRegistry(registry) {
    this.schemaRegistry = registry ?? null;
  }

  /**
   * Streams a Phi-4 response while emitting think & solution tokens separately via callbacks.
   *
   * @param {string} prompt user prompt
   * @param {(token: string) => void} [onToken] solution token callback
   * @param {(thought: string) => void} [onThink] reasoning block callback
   * @param {(error: string) => void} [onError] error callback
   * @param {object} [traceOptions] metadata for prompt logging
   * @returns {Promise<string>} assistant response content
   */
  async chatStream(prompt, onToken, onThink, onError, traceOptions = undefined) {
    if (!this.model) {
      const error = new Error("Model not loaded. Call load() before chatStream().");
      if (onError) {
        onError(error.message);
      }
      throw error;
    }
    if (!prompt || !prompt.trim()) {
      throw new Error("Prompt is required.");
    }

    let attempt = 0;
    const maxSchemaRetries = 1;
    const maxAttempts = 2 + maxSchemaRetries;
    const basePrompt = prompt;
    let currentPrompt = prompt;
    let schemaRetryCount = 0;
    while (attempt < maxAttempts) {
      this.chatHistory.push({ role: "user", content: currentPrompt });

      const traceContext = this.#buildTraceContext(traceOptions);
      const schemaDetails = this.#resolveSchema(traceContext);
      const startedAt = Date.now();
      const capturedThoughts = [];
      let requestSnapshot = null;
      let result = "";
      let schemaValidation = null;
      let schemaFailureDetails = null;

      try {
        this.chatHistory = await this.#truncateHistory();
        requestSnapshot = this.#buildRequestSnapshot(currentPrompt, traceContext, schemaDetails);
        const chat = Chat.from(this.chatHistory);
        const prediction = this.model.respond(chat);
        const parser = new Phi4StreamParser((thought) => {
          capturedThoughts.push(thought);
          if (onThink) {
            onThink(thought);
          }
        });
        const readable = Readable.from(prediction);
        const solutionStream = readable.pipe(parser);
        let streamError = null;
        const attachStreamError = (stream) => {
          if (!stream || typeof stream.once !== "function") {
            return;
          }
          stream.once("error", (err) => {
            const normalized = err instanceof Error ? err : new Error(String(err));
            streamError = normalized;
          });
        };
        attachStreamError(readable);
        attachStreamError(solutionStream);

        result = await this.#withPromptTimeout(async () => {
          let assistantResponse = "";
          for await (const fragment of solutionStream) {
            const token = fragment?.content ?? "";
            if (!token) continue;
            if (onToken) onToken(token);
            assistantResponse += token;
          }
          if (streamError) {
            throw streamError;
          }
          return assistantResponse;
        }, () => {
          if (typeof prediction?.return === "function") {
            try {
              prediction.return();
            } catch {
              // ignore prediction cancellation errors
            }
          }
        });

        const finishedAt = Date.now();
        const validationResult = this.#validateSchema(schemaDetails, result);
        schemaValidation = this.#summarizeValidation(validationResult);
        if (validationResult && !validationResult.valid) {
          const summary = this.#summarizeSchemaErrors(validationResult.errors);
          schemaFailureDetails = {
            summary,
            schemaId: schemaDetails?.id ?? traceContext.schemaId ?? "unknown",
          };
          throw new Error(
            `Phi-4 response failed schema validation (${schemaDetails?.id ?? "unknown"}): ${summary}`,
          );
        }
        if (result.length > 0) {
          this.chatHistory.push({ role: "assistant", content: result });
        }

        const responseSnapshot = {
          text: result,
          reasoning: capturedThoughts,
          startedAt,
          finishedAt,
          schemaId: schemaDetails?.id ?? null,
          schemaValidation,
        };
        await this.#recordPromptExchange(traceContext, requestSnapshot, responseSnapshot);
        await this.#trackPromptPerformance(
          traceContext,
          requestSnapshot,
          {
            ...responseSnapshot,
            tokensApprox: this.#approximateTokens(result),
          },
          null,
        );

        return result;
      } catch (error) {
        this.chatHistory.pop(); // remove user entry to preserve state
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = Date.now();
        const shouldRetry = attempt === 0 && this.#isRecoverableModelError(message);
        if (shouldRetry) {
          attempt += 1;
          try {
            await this.load();
          } catch {
            // swallow load errors so the retry can surface the original failure
          }
          continue;
        }
        const schemaRetryAllowed =
          schemaFailureDetails && schemaRetryCount < maxSchemaRetries;
        if (schemaRetryAllowed) {
          attempt += 1;
          schemaRetryCount += 1;
          currentPrompt = this.#buildSchemaRetryPrompt(
            basePrompt,
            schemaDetails,
            schemaFailureDetails.summary,
            schemaRetryCount,
          );
          continue;
        }
        let errorForThrow = error;
        if (onError) {
          try {
            onError(message);
          } catch (callbackError) {
            errorForThrow = callbackError;
          }
        }
        await this.#recordPromptExchange(
          traceContext,
          requestSnapshot,
          {
            text: result,
            reasoning: capturedThoughts,
            startedAt,
            finishedAt,
            schemaId: schemaDetails?.id ?? null,
            schemaValidation,
          },
          message,
        );
        await this.#trackPromptPerformance(
          traceContext,
          requestSnapshot,
          {
            text: result,
            reasoning: capturedThoughts,
            startedAt,
            finishedAt,
            schemaId: schemaDetails?.id ?? null,
            schemaValidation,
            tokensApprox: this.#approximateTokens(result),
          },
          message,
        );
        throw errorForThrow;
      }
    }

    throw new Error("Phi-4 chat stream exceeded retry budget.");
  }

  #isRecoverableModelError(message) {
    if (!message || typeof message !== "string") {
      return false;
    }
    return /model (?:not loaded|unloaded)/i.test(message) || /instance reference/i.test(message);
  }

  /**
   * Ensures chat history remains within the model's context window by trimming the oldest turns.
   * @returns {Promise<import("@lmstudio/sdk").MessageLike[]>}
   */
  async #truncateHistory() {
    if (!this.model) {
      throw new Error("Cannot truncate history without a loaded model.");
    }

    const reservedForResponse = 2048;
    const contextLength = await this.model.getContextLength();
    const maxTokens = Math.max(1024, contextLength - reservedForResponse);

    const systemPrompt = this.chatHistory[0];
    const mutableHistory = this.chatHistory.slice(1);
    const truncatedHistory = [systemPrompt];

    for (let i = mutableHistory.length - 1; i >= 0; i--) {
      const candidateHistory = [systemPrompt, ...mutableHistory.slice(i)];
      const chat = Chat.from(candidateHistory);
      const formatted = await this.model.applyPromptTemplate(chat);
      const tokenCount = await this.model.countTokens(formatted);
      if (tokenCount > maxTokens) {
        break;
      }
      truncatedHistory.splice(1, 0, mutableHistory[i]);
    }

    return truncatedHistory;
  }

  setPromptTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      this.promptTimeoutMs = null;
      return;
    }
    this.promptTimeoutMs = timeoutMs;
  }

  getHistory() {
    return this.chatHistory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
  }

  setHistory(history) {
    if (!Array.isArray(history) || history.length === 0) {
      this.clearHistory();
      return;
    }
    const sanitized = history
      .map((entry) => {
        if (!entry || typeof entry.role !== "string" || typeof entry.content !== "string") {
          return null;
        }
        return { role: entry.role, content: entry.content };
      })
      .filter(Boolean);
    if (sanitized.length === 0) {
      this.clearHistory();
      return;
    }
    if (sanitized[0].role !== "system") {
      sanitized.unshift({ role: "system", content: this.systemPrompt });
    } else {
      this.systemPrompt = sanitized[0].content;
    }
    this.chatHistory = sanitized;
  }

  async #withPromptTimeout(task, onTimeout) {
    const timeoutMs = this.promptTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return task();
    }
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (onTimeout) {
          onTimeout();
        }
        const minutes = Math.round((timeoutMs / 60000) * 10) / 10;
        reject(new Error(`Phi-4 prompt session exceeded ${minutes} minute limit.`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([task(), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  #buildTraceContext(options) {
    const scope = options?.scope === "main" ? "main" : "sub";
    const subPromptId = options?.subPromptId ?? randomUUID();
    const schemaId =
      typeof options?.schemaId === "string" && options.schemaId.trim()
        ? options.schemaId.trim().toLowerCase()
        : null;
    return {
      scope,
      label: options?.label ?? null,
      metadata: options?.metadata ?? null,
      mainPromptId: options?.mainPromptId ?? null,
      subPromptId,
      schemaId,
    };
  }

  #buildRequestSnapshot(prompt, traceContext, schemaDetails = undefined) {
    const messages = this.chatHistory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
    return {
      id: traceContext.subPromptId,
      model: MODEL_KEY,
      systemPrompt: this.systemPrompt,
      historyLength: messages.length,
      promptChars: prompt.length,
      promptText: prompt,
      schemaId: schemaDetails?.id ?? traceContext.schemaId ?? null,
      schemaPath: schemaDetails?.filePath ?? null,
      messages,
      createdAt: new Date().toISOString(),
    };
  }

  async #recordPromptExchange(traceContext, requestSnapshot, responseSnapshot, errorMessage = null) {
    if (!this.promptRecorder || !requestSnapshot) {
      return;
    }
    try {
      const metadata = this.#composeRecorderMetadata(traceContext, responseSnapshot);
      await this.promptRecorder.record({
        scope: traceContext.scope,
        label: traceContext.label,
        mainPromptId: traceContext.mainPromptId,
        subPromptId: traceContext.subPromptId,
        metadata,
        request: {
          ...requestSnapshot,
        },
        response: responseSnapshot
          ? {
              ...responseSnapshot,
              tokensApprox: this.#approximateTokens(responseSnapshot.text ?? ""),
              reasoningCount: responseSnapshot.reasoning?.length ?? 0,
            }
          : null,
        error: errorMessage,
      });
    } catch (error) {
      // Recording failures should not interrupt inference.
      const message = error instanceof Error ? error.message : String(error);
      process.emitWarning(message, "PromptRecorder");
    }
  }

  async #trackPromptPerformance(traceContext, requestSnapshot, responseSnapshot, errorMessage) {
    if (!this.performanceTracker || !requestSnapshot) {
      return;
    }
    try {
      await this.performanceTracker.track({
        traceContext,
        request: requestSnapshot,
        response: responseSnapshot,
        error: errorMessage ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.emitWarning(message, "PromptPerformanceTracker");
    }
  }

  #composeRecorderMetadata(traceContext, responseSnapshot) {
    const base = traceContext.metadata ? { ...traceContext.metadata } : {};
    const duration =
      responseSnapshot?.finishedAt && responseSnapshot?.startedAt
        ? responseSnapshot.finishedAt - responseSnapshot.startedAt
        : null;
    if (duration !== null) {
      base.durationMs = duration;
    }
    if (traceContext.schemaId) {
      base.schemaId = traceContext.schemaId;
    }
    if (responseSnapshot?.schemaValidation) {
      base.schemaValidation = responseSnapshot.schemaValidation;
    }
    return Object.keys(base).length > 0 ? base : null;
  }

  #resolveSchema(traceContext) {
    if (!this.schemaRegistry || !traceContext?.schemaId) {
      return null;
    }
    const schema = this.schemaRegistry.getSchema(traceContext.schemaId);
    if (!schema) {
      throw new Error(
        `Schema "${traceContext.schemaId}" was not found in docs/prompts. Add the schema or remove the schemaId.`,
      );
    }
    return schema;
  }

  #validateSchema(schemaDetails, responseText) {
    if (!schemaDetails || !this.schemaRegistry) {
      return null;
    }
    return this.schemaRegistry.validate(schemaDetails.id, responseText);
  }

  #summarizeValidation(validation) {
    if (!validation) {
      return null;
    }
    if (validation.valid) {
      return { valid: true };
    }
    return {
      valid: false,
      errors: Array.isArray(validation.errors) ? validation.errors.slice(0, 10) : null,
    };
  }

  #summarizeSchemaErrors(errors) {
    if (!errors || errors.length === 0) {
      return "Unknown schema mismatch.";
    }
    return errors.slice(0, 3).join("; ");
  }

  #buildSchemaRetryPrompt(basePrompt, schemaDetails, summary, retryCount) {
    const normalizedBase = typeof basePrompt === "string" ? basePrompt.trimEnd() : "";
    const reminderLines = [
      normalizedBase,
      "",
      "---",
      `Schema attempt ${retryCount}: Previous response failed schema "${
        schemaDetails?.id ?? "unknown"
      }" because ${summary}.`,
      "Reply again with STRICT JSON only; omit commentary, code fences, or greetings.",
    ];
    if (schemaDetails?.text) {
      reminderLines.push("Schema reference:", "```json", schemaDetails.text, "```");
    }
    return reminderLines.filter(Boolean).join("\n");
  }

  #approximateTokens(text) {
    if (!text) {
      return 0;
    }
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

export default Phi4Handler;
