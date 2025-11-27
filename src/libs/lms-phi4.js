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
    this.restClient = options?.restClient ?? null;
    this.preferRestTransport = Boolean(options?.preferRestTransport);
    this.chatHistory = [{ role: "system", content: this.systemPrompt }];
    this.promptRecorder = options?.promptRecorder ?? null;
    this.performanceTracker = options?.performanceTracker ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.noTokenTimeoutMs = options?.noTokenTimeoutMs ?? null;
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

  setNoTokenTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      this.noTokenTimeoutMs = null;
      return;
    }
    this.noTokenTimeoutMs = timeoutMs;
  }

  /**
   * Allows downstream callers to start/stop prompt recording dynamically.
   * @param {import("./prompt-recorder.js").default | null} recorder
   */
  setPromptRecorder(recorder) {
    this.promptRecorder = recorder ?? null;
  }

  /**
   * Configures the REST client and transport preference for Phi-4 calls.
   * @param {import("./lmstudio-api.js").LMStudioRestClient | null} restClient
   * @param {{ preferRestTransport?: boolean }} [options]
   */
  setRestClient(restClient, options = undefined) {
    this.restClient = restClient ?? null;
    if (typeof options?.preferRestTransport === "boolean") {
      this.preferRestTransport = options.preferRestTransport;
    }
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
    const maxHangRetries = 1;
    const maxAttempts = 2 + maxSchemaRetries + maxHangRetries;
    const basePrompt = prompt;
    let currentPrompt = prompt;
    let schemaRetryCount = 0;
    let hangRetryCount = 0;
    let restFallbackUsed = false;
    let heartbeatTimer = null;
    let lastErrorMessage = null;
    while (attempt < maxAttempts) {
      heartbeatTimer = null;
      this.chatHistory.push({ role: "user", content: currentPrompt });

      const traceContext = this._buildTraceContext(traceOptions);
      const schemaDetails = this._resolveSchema(traceContext);
      const startedAt = Date.now();
      const capturedThoughts = [];
      let requestSnapshot = null;
      let result = "";
      let schemaValidation = null;
      let schemaFailureDetails = null;
      let predictionHandle = null;
      let streamError = null;
      let solutionStreamHandle = null;
      let rawFragmentCount = 0;
      let solutionTokenCount = 0;
      const useRestTransport = this._shouldUseRest(traceContext);
      const cancelPrediction = (message) => {
        if (solutionStreamHandle && typeof solutionStreamHandle.destroy === "function") {
          try {
            solutionStreamHandle.destroy(new Error(message));
          } catch {
            // ignore destroy errors
          }
        }
        if (typeof predictionHandle?.cancel === "function") {
          try {
            const result = predictionHandle.cancel();
            if (result && typeof result.catch === "function") {
              result.catch(() => {});
            }
          } catch {
            // ignore best-effort cancellation errors
          }
          return;
        }
        if (typeof predictionHandle?.return === "function") {
          try {
            const result = predictionHandle.return();
            if (result && typeof result.catch === "function") {
              result.catch(() => {});
            }
          } catch {
            // ignore best-effort cancellation errors
          }
        }
      };
      const resetHeartbeat = () => {
        if (!Number.isFinite(this.noTokenTimeoutMs) || this.noTokenTimeoutMs <= 0) {
          return;
        }
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
        }
        heartbeatTimer = setTimeout(() => {
          const seconds = Math.round(this.noTokenTimeoutMs / 1000);
          const message = `No Phi-4 tokens emitted in ${seconds} seconds; cancelling prompt.`;
          this._recordPromptEvent(traceContext, requestSnapshot, {
            eventType: "no-token-timeout",
            severity: "error",
            message,
            metadata: {
              timeoutMs: this.noTokenTimeoutMs,
              schemaId: traceContext.schemaId ?? requestSnapshot?.schemaId ?? null,
            },
          });
          cancelPrediction(message);
          streamError = new Error(message);
        }, this.noTokenTimeoutMs);
      };

      try {
        try {
          // Skip SDK-based truncation when using REST transport, since it does not rely on a loaded model.
          this.chatHistory = useRestTransport ? this.chatHistory : await this._truncateHistory();
        } catch (truncateError) {
          const message =
            truncateError instanceof Error ? truncateError.message : String(truncateError ?? "");
          const recoverable = !useRestTransport && this._isRecoverableModelError(message);
          if (recoverable) {
            attempt += 1;
            try {
              await this.load();
            } catch {
              // ignore reload errors; retry loop will surface the failure
            }
            this.chatHistory.pop(); // remove the user entry added at the start of the loop
            continue;
          }
          throw truncateError;
        }
        requestSnapshot = this._buildRequestSnapshot(currentPrompt, traceContext, schemaDetails);
        if (useRestTransport) {
          result = await this._withPromptTimeout(
            async () => this._invokeRestCompletion(),
            () => {},
          );
          rawFragmentCount = result ? 1 : 0;
          solutionTokenCount = this._approximateTokens(result);
          if (onToken && result) {
            onToken(result);
          }
        } else {
          const chat = Chat.from(this.chatHistory);
          const prediction = this.model.respond(chat);
          predictionHandle = prediction;
          const parser = new Phi4StreamParser((thought) => {
            capturedThoughts.push(thought);
            if (onThink) {
              onThink(thought);
            }
          });
          const readable = Readable.from(prediction);
          readable.on("data", () => {
            rawFragmentCount += 1;
            resetHeartbeat();
          });
          const solutionStream = readable.pipe(parser);
          solutionStreamHandle = solutionStream;
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

          resetHeartbeat();
          result = await this._withPromptTimeout(async () => {
            let assistantResponse = "";
            for await (const fragment of solutionStream) {
              const token = fragment?.content ?? "";
              if (!token) continue;
              resetHeartbeat();
              if (onToken) onToken(token);
              assistantResponse += token;
              solutionTokenCount += 1;
            }
            if (streamError) {
              throw streamError;
            }
            if (typeof prediction?.result === "function") {
              try {
                const finalResult = await prediction.result();
                if (!assistantResponse && finalResult?.content) {
                  assistantResponse = finalResult.content;
                }
              } catch {
                // ignore result resolution failures; streaming response already captured
              }
            }
            return assistantResponse;
          }, () => cancelPrediction("Phi-4 prompt timeout"));
        }

        const finishedAt = Date.now();
        const validationResult = this._validateSchema(schemaDetails, result);
        schemaValidation = this._summarizeValidation(validationResult);
        if (validationResult && !validationResult.valid) {
          const summary = this._summarizeSchemaErrors(validationResult.errors);
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
          stream: {
            rawFragments: rawFragmentCount,
            solutionTokens: solutionTokenCount,
          },
          schemaId: schemaDetails?.id ?? null,
          schemaValidation,
        };
        await this._recordPromptExchange(traceContext, requestSnapshot, responseSnapshot);
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }
        await this._trackPromptPerformance(
          traceContext,
          requestSnapshot,
          {
            ...responseSnapshot,
            tokensApprox: this._approximateTokens(result),
          },
          null,
        );

        return result;
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }
        this.chatHistory.pop(); // remove user entry to preserve state
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = Date.now();
        const shouldRetry = attempt === 0 && this._isRecoverableModelError(message);
        if (shouldRetry) {
          attempt += 1;
          try {
            await this.load();
          } catch {
            // swallow load errors so the retry can surface the original failure
          }
          continue;
        }
        if (useRestTransport && !restFallbackUsed) {
          restFallbackUsed = true;
          attempt += 1;
          this.preferRestTransport = false;
          this._recordPromptEvent(traceContext, requestSnapshot, {
            eventType: "rest-fallback",
            severity: "warn",
            message: `REST transport failed; retrying with WS (${message})`,
            metadata: {
              attempt,
              transport: "rest",
              schemaId: traceContext.schemaId ?? null,
            },
          });
          currentPrompt = basePrompt;
          continue;
        }
        const hangRetryAllowed =
          hangRetryCount < maxHangRetries && this._isStreamingHang(message);
        if (hangRetryAllowed) {
          hangRetryCount += 1;
          attempt += 1;
          if (useRestTransport) {
            // REST stalled; flip to WS transport for the retry.
            this.preferRestTransport = false;
          }
          this._recordPromptEvent(traceContext, requestSnapshot, {
            eventType: "stream-retry",
            severity: "warn",
            message: `Retrying Phi-4 after streaming hang (${useRestTransport ? "switching to WS" : "same transport"}): ${message}`,
            metadata: {
              attempt,
              hangRetryCount,
              rawFragments: rawFragmentCount,
              solutionTokens: solutionTokenCount,
            },
          });
          currentPrompt = basePrompt;
          continue;
        }
        const schemaRetryAllowed =
          schemaFailureDetails && schemaRetryCount < maxSchemaRetries;
        if (schemaRetryAllowed) {
          attempt += 1;
          schemaRetryCount += 1;
          currentPrompt = this._buildSchemaRetryPrompt(
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
        await this._recordPromptExchange(
          traceContext,
          requestSnapshot,
          {
            text: result,
            reasoning: capturedThoughts,
            startedAt,
            finishedAt,
            stream: {
              rawFragments: rawFragmentCount,
              solutionTokens: solutionTokenCount,
            },
            schemaId: schemaDetails?.id ?? null,
            schemaValidation,
          },
          message,
        );
        await this._trackPromptPerformance(
          traceContext,
          requestSnapshot,
          {
            text: result,
            reasoning: capturedThoughts,
            startedAt,
            finishedAt,
            schemaId: schemaDetails?.id ?? null,
            schemaValidation,
            stream: {
              rawFragments: rawFragmentCount,
              solutionTokens: solutionTokenCount,
            },
            tokensApprox: this._approximateTokens(result),
          },
          message,
        );
        throw errorForThrow;
      }
    }

    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }

    const budgetDetails =
      typeof lastErrorMessage === "string" && lastErrorMessage
        ? ` Last error: ${lastErrorMessage}`
        : "";
    throw new Error(`Phi-4 chat stream exceeded retry budget.${budgetDetails}`);
  }

  _isRecoverableModelError(message) {
    if (!message || typeof message !== "string") {
      return false;
    }
    return /model (?:not loaded|unloaded)/i.test(message) || /instance reference/i.test(message);
  }

  _isStreamingHang(message) {
    if (!message || typeof message !== "string") {
      return false;
    }
    const normalized = message.toLowerCase();
    return (
      normalized.includes("no phi-4 tokens emitted") ||
      normalized.includes("prompt session exceeded") ||
      normalized.includes("timed out") ||
      (normalized.includes("stream") && normalized.includes("timeout"))
    );
  }

  _shouldUseRest(traceContext = undefined) {
    if (!this.restClient) {
      return false;
    }
    if (process.env.MINIPHI_FORCE_REST === "1") {
      return true;
    }
    if (typeof traceContext?.transport === "string") {
      return traceContext.transport === "rest";
    }
    return this.preferRestTransport;
  }

  _buildRestMessages() {
    if (!Array.isArray(this.chatHistory)) {
      return [];
    }
    return this.chatHistory
      .filter((entry) => entry && typeof entry.role === "string" && typeof entry.content === "string")
      .map((entry) => ({
        role: entry.role,
        content: entry.content,
      }));
  }

  async _invokeRestCompletion() {
    if (!this.restClient) {
      throw new Error("LM Studio REST client is not configured for Phi-4.");
    }
    const messages = this._buildRestMessages();
    const response = await this.restClient.createChatCompletion({
      messages,
      stream: false,
      max_tokens: -1,
    });
    const choice = response?.choices?.[0];
    const text =
      choice?.message?.content ??
      choice?.delta?.content ??
      (typeof response === "string" ? response : null) ??
      "";
    if (!text) {
      throw new Error("Phi-4 REST completion returned an empty response.");
    }
    return text;
  }

  /**
   * Ensures chat history remains within the model's context window by trimming the oldest turns.
   * @returns {Promise<import("@lmstudio/sdk").MessageLike[]>}
   */
  async _truncateHistory() {
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

  async getContextWindow() {
    if (!this.model || typeof this.model.getContextLength !== "function") {
      return null;
    }
    try {
      return await this.model.getContextLength();
    } catch {
      return null;
    }
  }

  async _withPromptTimeout(task, onTimeout) {
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

  _buildTraceContext(options) {
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

  _buildRequestSnapshot(prompt, traceContext, schemaDetails = undefined) {
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

  async _recordPromptExchange(traceContext, requestSnapshot, responseSnapshot, errorMessage = null) {
    if (!this.promptRecorder || !requestSnapshot) {
      return;
    }
    try {
      const metadata = this._composeRecorderMetadata(traceContext, responseSnapshot);
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
              tokensApprox: this._approximateTokens(responseSnapshot.text ?? ""),
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

  async _trackPromptPerformance(traceContext, requestSnapshot, responseSnapshot, errorMessage) {
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

  _recordPromptEvent(traceContext, requestSnapshot, event) {
    if (!this.performanceTracker || typeof this.performanceTracker.recordEvent !== "function") {
      return;
    }
    try {
      const result = this.performanceTracker.recordEvent({
        traceContext,
        request: requestSnapshot,
        eventType: event?.eventType ?? "event",
        severity: event?.severity ?? "info",
        message: event?.message ?? "",
        metadata: event?.metadata ?? null,
      });
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.emitWarning(message, "PromptPerformanceTracker");
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.emitWarning(message, "PromptPerformanceTracker");
    }
  }

  _composeRecorderMetadata(traceContext, responseSnapshot) {
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

  _resolveSchema(traceContext) {
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

  _validateSchema(schemaDetails, responseText) {
    if (!schemaDetails || !this.schemaRegistry) {
      return null;
    }
    return this.schemaRegistry.validate(schemaDetails.id, responseText);
  }

  _summarizeValidation(validation) {
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

  _summarizeSchemaErrors(errors) {
    if (!errors || errors.length === 0) {
      return "Unknown schema mismatch.";
    }
    return errors.slice(0, 3).join("; ");
  }

  _buildSchemaRetryPrompt(basePrompt, schemaDetails, summary, retryCount) {
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

  _approximateTokens(text) {
    if (!text) {
      return 0;
    }
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

export default Phi4Handler;
