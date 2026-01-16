import { Chat } from "@lmstudio/sdk";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import LMStudioManager from "./lmstudio-api.js";
import Phi4StreamParser from "./phi4-stream-parser.js";
import { DEFAULT_CONTEXT_LENGTH, DEFAULT_MODEL_KEY } from "./model-presets.js";
import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";
import { isProtocolWarningError, isStreamingHangError } from "./lmstudio-error-utils.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are MiniPhi, a local workspace agent.",
  "Inspect the provided workspace context (codebases, documentation hubs, or book-style markdown collections) and adapt your strategy accordingly.",
  "When the directory resembles a book or documentation set, provide a cohesive overview, suggest edits, and propose new sections/chapters when helpful.",
  "When the directory is code-heavy, act as an expert code engineer while still respecting any docs present.",
  "Always explain your reasoning, keep instructions actionable, and operate directly on the artifacts referenced in the prompt.",
].join(" ");

export class LMStudioProtocolError extends Error {
  constructor(message, metadata = undefined) {
    super(message || "LM Studio protocol warning");
    this.name = "LMStudioProtocolError";
    this.metadata = metadata ?? null;
  }
}

/**
 * Layer 2 handler that encapsulates LM Studio chat behavior (system prompt, history management,
 * <think> parsing and streaming support). Relies on LMStudioManager for the actual model handles.
 */
export class LMStudioHandler {
  /**
   * @param {LMStudioManager} manager
   * @param {{ systemPrompt?: string }} [options]
   */
  constructor(manager = new LMStudioManager(), options = undefined) {
    this.manager = manager;
    this.model = null;
    this.modelKey = options?.modelKey ?? DEFAULT_MODEL_KEY;
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
    this.protocolGate = {
      wsDisabled: false,
      lastWarning: null,
    };
  }

  /**
   * Loads the configured model with the requested configuration (defaults to the global context baseline).
   * @param {import("@lmstudio/sdk").LLMLoadModelConfig} [config]
   */
  async load(config = undefined) {
    this.model = await this.manager.getModel(this.modelKey, {
      contextLength: DEFAULT_CONTEXT_LENGTH,
      ...(config ?? {}),
    });
  }

  /**
   * Ejects the active model and resets history cache.
   */
  async eject() {
    await this.manager.ejectModel(this.modelKey);
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
   * Configures the REST client and transport preference for LM Studio calls.
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
   * Streams a model response while emitting think & solution tokens separately via callbacks.
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
      const requestedResponseFormat =
        traceContext.responseFormat ?? this._buildJsonSchemaResponseFormat(schemaDetails) ?? null;
      if (!traceContext.responseFormat && requestedResponseFormat) {
        traceContext.responseFormat = requestedResponseFormat;
      }
      const startedAt = Date.now();
      const slowStartThresholdMs = this._resolveSlowStartThreshold();
      let firstTokenAt = null;
      let slowStartEmitted = false;
      const capturedThoughts = [];
      let requestSnapshot = null;
      let result = "";
      let responseToolCalls = null;
      let schemaValidation = null;
      let schemaFailureDetails = null;
      let predictionHandle = null;
      let streamError = null;
      let solutionStreamHandle = null;
      let rawFragmentCount = 0;
      let solutionTokenCount = 0;
      const useRestTransport = this._shouldUseRest(traceContext);
      const maybeRecordSlowStart = (tokenTime, transport) => {
        if (slowStartEmitted) {
          return;
        }
        if (!Number.isFinite(slowStartThresholdMs) || slowStartThresholdMs <= 0) {
          return;
        }
        const delayMs = tokenTime - startedAt;
        if (delayMs < slowStartThresholdMs) {
          return;
        }
        slowStartEmitted = true;
        const seconds = Math.round(delayMs / 1000);
        const thresholdSeconds = Math.round(slowStartThresholdMs / 1000);
        this._recordPromptEvent(traceContext, requestSnapshot, {
          eventType: "slow-start",
          severity: "warn",
          message: `First token delayed ${seconds}s (threshold ${thresholdSeconds}s).`,
          metadata: {
            timeToFirstTokenMs: delayMs,
            thresholdMs: slowStartThresholdMs,
            transport,
            schemaId: traceContext.schemaId ?? requestSnapshot?.schemaId ?? null,
          },
        });
      };
      const markFirstToken = (transport) => {
        if (firstTokenAt) {
          return;
        }
        firstTokenAt = Date.now();
        maybeRecordSlowStart(firstTokenAt, transport);
      };
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
          const message = `No ${this.modelKey} tokens emitted in ${seconds} seconds; cancelling prompt.`;
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
          const restResult = await this._withPromptTimeout(
            async () => this._invokeRestCompletion(requestedResponseFormat),
            () => {},
          );
          result = restResult?.text ?? "";
          responseToolCalls = restResult?.toolCalls ?? null;
          rawFragmentCount = result ? 1 : 0;
          solutionTokenCount = this._approximateTokens(result);
          markFirstToken("rest");
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
            markFirstToken("ws");
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
          }, () => cancelPrediction(`${this.modelKey} prompt timeout`));
        }

        if (!result || !result.trim()) {
          throw new Error(`${this.modelKey} returned an empty response.`);
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
            `${this.modelKey} response failed schema validation (${
              schemaDetails?.id ?? "unknown"
            }): ${summary}`,
          );
        }
        if (result.length > 0) {
          this.chatHistory.push({ role: "assistant", content: result });
        }

        const responseSnapshot = {
          text: result,
          rawResponseText: result,
          reasoning: capturedThoughts,
          startedAt,
          finishedAt,
          timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
          stream: {
            rawFragments: rawFragmentCount,
            solutionTokens: solutionTokenCount,
          },
          schemaId: schemaDetails?.id ?? null,
          schemaValidation,
          tool_calls: responseToolCalls ?? null,
          tool_definitions: traceContext?.toolDefinitions ?? null,
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
          let transport = useRestTransport ? "rest" : "ws";
          if (useRestTransport) {
            // REST stalled; flip to WS transport for the retry.
            this.preferRestTransport = false;
          } else if (this.restClient) {
            // WS stalled; flip to REST transport if available.
            this.preferRestTransport = true;
            transport = "ws->rest";
          }
          this._recordPromptEvent(traceContext, requestSnapshot, {
            eventType: "stream-retry",
            severity: "warn",
            message: `Retrying ${this.modelKey} after streaming hang (${transport}): ${message}`,
            metadata: {
              attempt,
              hangRetryCount,
              rawFragments: rawFragmentCount,
              solutionTokens: solutionTokenCount,
              transport,
            },
          });
          currentPrompt = basePrompt;
          continue;
        }
        const protocolWarning = this._isProtocolWarning(message);
        if (protocolWarning) {
          const metadata = await this._collectProtocolSnapshot({
            transport: useRestTransport ? "rest" : "ws",
            warning: protocolWarning,
            rawMessage: message,
          });
          this.protocolGate.wsDisabled = true;
          this.protocolGate.lastWarning = protocolWarning;
          this.protocolGate.lastSnapshot = metadata;
          this._recordPromptEvent(traceContext, requestSnapshot, {
            eventType: "protocol-warning",
            severity: "error",
            message: protocolWarning,
            metadata,
          });
          if (!useRestTransport && this.restClient) {
            attempt += 1;
            currentPrompt = basePrompt;
            this.preferRestTransport = true;
            continue;
          }
          throw new LMStudioProtocolError(
            this._formatProtocolErrorMessage(protocolWarning, metadata),
            metadata,
          );
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
            rawResponseText: result,
            reasoning: capturedThoughts,
            startedAt,
            finishedAt,
            timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
            stream: {
              rawFragments: rawFragmentCount,
              solutionTokens: solutionTokenCount,
            },
            schemaId: schemaDetails?.id ?? null,
            schemaValidation,
            tool_calls: responseToolCalls ?? null,
            tool_definitions: traceContext?.toolDefinitions ?? null,
          },
          message,
        );
        await this._trackPromptPerformance(
          traceContext,
          requestSnapshot,
          {
            text: result,
            rawResponseText: result,
            reasoning: capturedThoughts,
            startedAt,
            finishedAt,
            schemaId: schemaDetails?.id ?? null,
            schemaValidation,
            stream: {
              rawFragments: rawFragmentCount,
              solutionTokens: solutionTokenCount,
            },
            tool_calls: responseToolCalls ?? null,
            tool_definitions: traceContext?.toolDefinitions ?? null,
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
    throw new Error(`${this.modelKey} chat stream exceeded retry budget.${budgetDetails}`);
  }

  _isRecoverableModelError(message) {
    if (!message || typeof message !== "string") {
      return false;
    }
    return /model (?:not loaded|unloaded)/i.test(message) || /instance reference/i.test(message);
  }

  _isStreamingHang(message) {
    return isStreamingHangError(message);
  }

  _isProtocolWarning(message) {
    if (!message || typeof message !== "string") {
      return null;
    }
    return isProtocolWarningError(message) ? message : null;
  }

  _buildProtocolMetadata() {
    return {
      sdkVersion:
        typeof this.manager?.getSdkVersion === "function" ? this.manager.getSdkVersion() : null,
      restBaseUrl: this.restClient?.baseUrl ?? null,
      apiVersion: this.restClient?.apiVersion ?? null,
      model: this.modelKey ?? null,
    };
  }

  async _collectProtocolSnapshot(additional = undefined) {
    const metadata = {
      ...this._buildProtocolMetadata(),
      ...(additional ?? {}),
    };
    metadata.wsDisabled = this.protocolGate?.wsDisabled ?? false;
    metadata.preferRestTransport = this.preferRestTransport ?? false;
    if (this.restClient) {
      try {
        const status = await this.restClient.getStatus();
        metadata.restStatus = status ?? null;
        metadata.serverVersion = this._extractServerVersion(status);
        metadata.restStatusOk =
          typeof status?.ok === "boolean"
            ? status.ok
            : typeof status?.status?.ok === "boolean"
              ? status.status.ok
              : null;
      } catch (error) {
        metadata.restStatusError = error instanceof Error ? error.message : String(error);
      }
    }
    return metadata;
  }

  _extractServerVersion(statusPayload) {
    if (!statusPayload || typeof statusPayload !== "object") {
      return null;
    }
    const candidates = [
      statusPayload?.status?.lmstudio?.version,
      statusPayload?.status?.lmstudio_version,
      statusPayload?.lmstudio?.version,
      statusPayload?.lmstudio_version,
      statusPayload?.status?.version,
      statusPayload?.version,
    ];
    return candidates.find((value) => typeof value === "string" && value.trim().length > 0) ?? null;
  }

  _formatProtocolErrorMessage(protocolWarning, metadata = undefined) {
    const summaryParts = [];
    if (metadata?.sdkVersion) {
      summaryParts.push(`SDK ${metadata.sdkVersion}`);
    }
    if (metadata?.serverVersion) {
      summaryParts.push(`Server ${metadata.serverVersion}`);
    }
    if (metadata?.restBaseUrl) {
      summaryParts.push(metadata.restBaseUrl);
    }
    if (metadata?.transport) {
      summaryParts.push(`transport=${metadata.transport}`);
    }
    const suffix = summaryParts.length ? ` (${summaryParts.join(" | ")})` : "";
    return `LM Studio protocol warning${suffix}: ${protocolWarning}`;
  }

  _shouldUseRest(traceContext = undefined) {
    if (!this.restClient) {
      return false;
    }
    if (this.protocolGate?.wsDisabled) {
      return true;
    }
    if (process.env.MINIPHI_FORCE_REST === "1") {
      return true;
    }
    if (typeof traceContext?.transport === "string") {
      const normalized = traceContext.transport.toLowerCase();
      if (normalized === "ws") {
        return false;
      }
      if (normalized === "rest") {
        return true;
      }
    }
    const responseType = traceContext?.responseFormat?.type;
    if (typeof responseType === "string" && responseType.toLowerCase() === "json_schema") {
      return true;
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

  async _invokeRestCompletion(responseFormat = null) {
    if (!this.restClient) {
      throw new Error(`LM Studio REST client is not configured for model ${this.modelKey}.`);
    }
    const messages = this._buildRestMessages();
    const response = await this.restClient.createChatCompletion({
      messages,
      stream: false,
      max_tokens: -1,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    });
    const choice = response?.choices?.[0];
    const text =
      choice?.message?.content ??
      choice?.delta?.content ??
      (typeof response === "string" ? response : null) ??
      "";
    if (!text) {
      throw new Error(`LM Studio REST completion returned an empty response for ${this.modelKey}.`);
    }
    return {
      text,
      toolCalls: choice?.message?.tool_calls ?? null,
    };
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
    if (mutableHistory.length === 0) {
      return [systemPrompt];
    }
    let lastUserIndex = -1;
    for (let i = mutableHistory.length - 1; i >= 0; i--) {
      if (mutableHistory[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    let chosenStart = null;

    for (let i = mutableHistory.length - 1; i >= 0; i--) {
      if (mutableHistory[i]?.role !== "user") {
        continue;
      }
      const candidateHistory = [systemPrompt, ...mutableHistory.slice(i)];
      try {
        const chat = Chat.from(candidateHistory);
        const formatted = await this.model.applyPromptTemplate(chat);
        const tokenCount = await this.model.countTokens(formatted);
        if (tokenCount > maxTokens) {
          break;
        }
        chosenStart = i;
      } catch (error) {
        // Skip invalid history slices (e.g., non-alternating roles) and keep scanning.
        continue;
      }
    }

    if (lastUserIndex < 0) {
      return [systemPrompt];
    }
    const startIndex = chosenStart ?? lastUserIndex;
    return [systemPrompt, ...mutableHistory.slice(startIndex)];
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
        reject(new Error(`${this.modelKey} prompt session exceeded ${minutes} minute limit.`));
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
    const responseFormat =
      options && typeof options.responseFormat === "object" ? options.responseFormat : null;
    return {
      scope,
      label: options?.label ?? null,
      metadata: options?.metadata ?? null,
      mainPromptId: options?.mainPromptId ?? null,
      subPromptId,
      schemaId,
      responseFormat,
      toolDefinitions: options?.toolDefinitions ?? null,
    };
  }

  _buildRequestSnapshot(prompt, traceContext, schemaDetails = undefined) {
    const messages = this.chatHistory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
    return {
      id: traceContext.subPromptId,
      model: this.modelKey,
      systemPrompt: this.systemPrompt,
      historyLength: messages.length,
      promptChars: prompt.length,
      promptText: prompt,
      schemaId: schemaDetails?.id ?? traceContext.schemaId ?? null,
      schemaPath: schemaDetails?.filePath ?? null,
      responseFormat: traceContext.responseFormat ?? null,
      response_format: traceContext.responseFormat ?? null,
      toolDefinitions: traceContext?.toolDefinitions ?? null,
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

  _resolveSlowStartThreshold() {
    const candidates = [];
    if (Number.isFinite(this.noTokenTimeoutMs) && this.noTokenTimeoutMs > 0) {
      candidates.push(Math.round(this.noTokenTimeoutMs * 0.1));
    }
    if (Number.isFinite(this.promptTimeoutMs) && this.promptTimeoutMs > 0) {
      candidates.push(Math.round(this.promptTimeoutMs * 0.25));
    }
    const base = candidates.length ? Math.min(...candidates) : 30000;
    return Math.max(5000, Math.min(base, 60000));
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

  _buildJsonSchemaResponseFormat(schemaDetails) {
    if (!schemaDetails?.definition || typeof schemaDetails.definition !== "object") {
      return null;
    }
    return buildJsonSchemaResponseFormat(
      schemaDetails.definition,
      schemaDetails.id ?? "miniphi-response",
    );
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

export default LMStudioHandler;
export { LMStudioHandler as Phi4Handler };
// LMStudioProtocolError is already exported via `export class LMStudioProtocolError ...` above.
