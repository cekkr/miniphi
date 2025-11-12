import { Chat } from "@lmstudio/sdk";
import { Readable } from "stream";
import LMStudioManager from "./lmstudio-api.js";
import Phi4StreamParser from "./phi4-stream-parser.js";

const MODEL_KEY = "microsoft/Phi-4-reasoning-plus";
const DEFAULT_SYSTEM_PROMPT = "You are a agent project source code helper:";
const DEFAULT_PROMPT_TIMEOUT_MS = Number(process.env.MINIPHI_PROMPT_TIMEOUT_MS ?? 20 * 60 * 1000);

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
        : DEFAULT_PROMPT_TIMEOUT_MS;
    this.chatHistory = [{ role: "system", content: this.systemPrompt }];
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
   * Streams a Phi-4 response while emitting think & solution tokens separately via callbacks.
   *
   * @param {string} prompt user prompt
   * @param {(token: string) => void} [onToken] solution token callback
   * @param {(thought: string) => void} [onThink] reasoning block callback
   * @param {(error: string) => void} [onError] error callback
   * @returns {Promise<string>} assistant response content
   */
  async chatStream(prompt, onToken, onThink, onError) {
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

    this.chatHistory.push({ role: "user", content: prompt });

    try {
      this.chatHistory = await this.#truncateHistory();
      const chat = Chat.from(this.chatHistory);
      const prediction = this.model.respond(chat);
      const parser = new Phi4StreamParser(onThink);
      const readable = Readable.from(prediction);
      const solutionStream = readable.pipe(parser);

      const result = await this.#withPromptTimeout(async () => {
        let assistantResponse = "";
        for await (const fragment of solutionStream) {
          const token = fragment?.content ?? "";
          if (!token) continue;
          if (onToken) onToken(token);
          assistantResponse += token;
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

      if (result.length > 0) {
        this.chatHistory.push({ role: "assistant", content: result });
      }

      return result;
    } catch (error) {
      this.chatHistory.pop(); // remove user entry to preserve state
      const message = error instanceof Error ? error.message : String(error);
      if (onError) onError(message);
      throw error;
    }
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
}

export default Phi4Handler;
