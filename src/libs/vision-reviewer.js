import { pathToFileURL } from "node:url";
import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";

export const VISUAL_REVIEW_SCHEMA_ID = "visual-review";
const SCHEMA_VERSION = "visual-review@v1";
const DEFAULT_TIMEOUT_MS = 45000;
// 512 was sized for a non-reasoning VLM. A reasoning model's trace alone can
// exceed it, and the request then returns `finish_reason: "length"` with empty
// content — a schema failure that no retry at the same cap can fix.
const DEFAULT_MAX_TOKENS = 3072;
const DEFAULT_WAIT_MS = 600;
const DEFAULT_VIEWPORT = { width: 1200, height: 800 };
const DEFAULT_NAV_TIMEOUT_MS = 30000;

let puppeteerModule = null;
async function loadPuppeteer() {
  if (!puppeteerModule) {
    puppeteerModule = await import("puppeteer");
  }
  return puppeteerModule?.default ?? puppeteerModule;
}

/**
 * Loopback only. A `file://` screenshot cannot review an app that only exists
 * once a server is running, but a `visual_review` that could fetch *any* URL
 * would turn a model-authored string into an outbound request from the
 * operator's machine. The workspace agent is a local file agent; the only
 * server it can legitimately be looking at is one it just started here.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Normalizes a model-supplied review target to a loopback http(s) URL, or null.
 * Exported so the executor rejects a bad target *before* the action is
 * scheduled rather than failing inside Puppeteer.
 */
export function normalizeReviewUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ? parsed.href : null;
}

/**
 * Renders a local file *or* a loopback URL in headless Chromium and returns a
 * base64 PNG screenshot. Shares the launch pattern already proven by
 * web-browser.js and the basketball-page live test.
 *
 * `waitUntil` differs by target on purpose: a local file is done when it has
 * loaded, while a page served by an app the agent just wrote is usually still
 * fetching its own images and API data, and screenshotting it at `load` shows
 * an empty feed the vision model then reports as a bug.
 */
export async function screenshotTarget({
  absolutePath = null,
  url = null,
  waitMs = DEFAULT_WAIT_MS,
  viewport = DEFAULT_VIEWPORT,
  timeoutMs = DEFAULT_NAV_TIMEOUT_MS,
} = {}) {
  const normalizedUrl = url ? normalizeReviewUrl(url) : null;
  if (url && !normalizedUrl) {
    return {
      ok: false,
      error: `url "${url}" is not an http(s) loopback address`,
      pageErrors: [],
      consoleErrors: [],
    };
  }
  if (!normalizedUrl && !absolutePath) {
    return {
      ok: false,
      error: "absolutePath or a loopback url is required",
      pageErrors: [],
      consoleErrors: [],
    };
  }
  const target = normalizedUrl ?? pathToFileURL(absolutePath).href;
  let browser = null;
  try {
    const puppeteer = await loadPuppeteer();
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport(viewport);
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text().slice(0, 400));
      }
    });
    await page.goto(target, {
      waitUntil: normalizedUrl ? "networkidle2" : "load",
      timeout: timeoutMs,
    });
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const buffer = await page.screenshot({ type: "png" });
    return {
      ok: true,
      base64: buffer.toString("base64"),
      target,
      pageErrors,
      consoleErrors: consoleErrors.slice(0, 10),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      pageErrors: [],
      consoleErrors: [],
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/** Back-compatible alias for the file-only callers that predate URL support. */
export const screenshotLocalFile = (options = undefined) => screenshotTarget(options);

/**
 * True when the model stopped because it ran out of tokens *before* emitting
 * any content — the signature of a reasoning model whose trace alone exceeded
 * the cap. Distinguishing this from ordinary invalid JSON is what makes the
 * failure actionable (raise the budget) instead of just "the model drifted".
 */
export function isTruncatedBeforeContent(completion, responseText) {
  if (typeof responseText === "string" && responseText.trim()) {
    return false;
  }
  const choice = completion?.choices?.[0];
  if (choice?.finish_reason !== "length") {
    return false;
  }
  const reasoningTokens = Number(
    completion?.usage?.completion_tokens_details?.reasoning_tokens ??
      completion?.usage?.completionTokensDetails?.reasoningTokens ??
      0,
  );
  return reasoningTokens > 0;
}

const deterministicReview = (reason) => ({
  schema_version: SCHEMA_VERSION,
  matches_intent: false,
  quality_score: 0,
  description: "",
  issues: [],
  suggestions: [],
  needs_more_context: false,
  missing_snippets: [],
  stop_reason: reason,
});

/**
 * Sends a screenshot to a vision-capable model and asks it to critique what it
 * actually sees, grounded in a strict JSON schema instead of prose. Mirrors
 * ContextReferenceComposer: one retry on invalid JSON, then a deterministic
 * fallback so a flaky or unavailable VLM cannot stall the agent loop.
 */
export class VisionReviewer {
  constructor(options = undefined) {
    this.client = options?.client ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.model =
      typeof options?.model === "string" && options.model.trim() ? options.model.trim() : null;
    this.timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1000, Math.floor(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    this.maxTokens = Number.isFinite(options?.maxTokens)
      ? Math.max(128, Math.floor(options.maxTokens))
      : DEFAULT_MAX_TOKENS;
  }

  _schema() {
    return this.schemaRegistry?.getSchema(VISUAL_REVIEW_SCHEMA_ID) ?? null;
  }

  async review({ imageBase64, focus = null, turn = 0, sessionDeadline = null } = {}) {
    const schema = this._schema();
    const audit = {
      schemaVersion: SCHEMA_VERSION,
      turn,
      model: this.model,
      startedAt: new Date().toISOString(),
      attempts: [],
      fallback: null,
    };
    if (!imageBase64) {
      const response = deterministicReview("no-screenshot");
      audit.fallback = response.stop_reason;
      return { response, audit };
    }
    if (!this.client || !this.model || !schema || !this.schemaRegistry) {
      const response = deterministicReview("vision-reviewer-unavailable");
      audit.fallback = response.stop_reason;
      return { response, audit };
    }

    const schemaBlock = this.schemaRegistry.buildInstructionBlock(VISUAL_REVIEW_SCHEMA_ID, {
      compact: true,
    });
    const responseFormat = buildJsonSchemaResponseFormat(schema.definition, VISUAL_REVIEW_SCHEMA_ID);
    const focusText =
      typeof focus === "string" && focus.trim()
        ? focus.trim()
        : "Assess general visual quality and correctness.";
    const system = `You are a vision-language reviewer helping a coding agent judge a rendered screenshot.
Look only at the attached image. Reply with ONLY JSON matching the exact schema below, no prose, no markdown fences.
Be concrete: name shapes, colors, positions, and motion artifacts you can actually see; never invent details you cannot see.

Focus: ${focusText}

Exact JSON schema:
${schemaBlock}`;

    let lastError = "invalid-response";
    let budgetTokens = this.maxTokens;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = Number.isFinite(sessionDeadline)
        ? Math.floor(sessionDeadline - Date.now())
        : null;
      if (remainingMs !== null && remainingMs <= 0) {
        lastError = "session-timeout";
        break;
      }
      const messages = [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                attempt === 0
                  ? "Review this screenshot."
                  : "Your previous response was invalid. Return only schema-valid JSON.",
            },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
          ],
        },
      ];
      // The audit log records the request without the base64 payload so
      // transcripts/journals stay small and screenshots are not duplicated on disk.
      const auditMessages = [
        { role: "system", content: system },
        { role: "user", content: "[image omitted from audit log]" },
      ];
      let completion = null;
      let responseText = "";
      try {
        completion = await this.client.createChatCompletion({
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: budgetTokens,
          timeoutMs:
            remainingMs === null
              ? this.timeoutMs
              : Math.max(1000, Math.min(this.timeoutMs, remainingMs)),
          response_format: responseFormat,
        });
        const message = completion?.choices?.[0]?.message ?? null;
        responseText = typeof message?.content === "string" ? message.content : "";
        const validation = this.schemaRegistry.validate(VISUAL_REVIEW_SCHEMA_ID, responseText);
        audit.attempts.push({
          attempt: attempt + 1,
          request: {
            messages: auditMessages,
            response_format: responseFormat,
            model: this.model,
          },
          response: {
            text: responseText,
            usage: completion?.usage ?? null,
            reasoning: completion?.miniphi_reasoning ?? null,
          },
          validation: {
            valid: Boolean(validation?.valid),
            status: validation?.status ?? null,
            error: validation?.error ?? null,
            preambleDetected: Boolean(validation?.preambleDetected),
          },
        });
        if (validation?.valid && validation.parsed) {
          return {
            response: validation.parsed,
            audit: { ...audit, finishedAt: new Date().toISOString() },
          };
        }
        // "No valid JSON found" is the wrong diagnosis when the model never got
        // to the JSON: a reasoning model that spends the whole token budget
        // thinking returns `finish_reason: "length"` with empty content. Saying
        // so — and retrying with room — is the difference between a fixable
        // report and a mystery. Seen against prism-ml/bonsai-27b, whose
        // reasoning trace alone exceeds a 512-token cap.
        if (isTruncatedBeforeContent(completion, responseText)) {
          budgetTokens = budgetTokens > 0 ? budgetTokens * 4 : budgetTokens;
          lastError = `the model used its entire ${completion?.usage?.completion_tokens ?? "?"}-token budget on reasoning and returned no content`;
        } else {
          lastError = validation?.error ?? "schema validation failed";
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        audit.attempts.push({
          attempt: attempt + 1,
          request: { messages: auditMessages, response_format: responseFormat, model: this.model },
          response: { text: responseText, usage: completion?.usage ?? null },
          validation: { valid: false, status: "request-failed", error: lastError, preambleDetected: false },
        });
      }
    }
    const response = deterministicReview(`invalid-response: ${lastError}`);
    audit.fallback = response.stop_reason;
    audit.finishedAt = new Date().toISOString();
    return { response, audit };
  }
}

/**
 * Composes screenshot capture + the vision-model critique into the single
 * async function AgentSession's `visionReview` option expects, keeping the
 * session itself decoupled from Puppeteer and vision-model wiring.
 */
export function createVisionReviewAction({
  restClient,
  schemaRegistry,
  model,
  timeoutMs,
  maxTokens,
  screenshotOptions,
} = {}) {
  if (!restClient || !schemaRegistry || !model) {
    return null;
  }
  const reviewer = new VisionReviewer({ client: restClient, schemaRegistry, model, timeoutMs, maxTokens });
  return async function visionReviewAction({
    absolutePath = null,
    url = null,
    focus = null,
    sessionDeadline = null,
  } = {}) {
    const capture = await screenshotTarget({ absolutePath, url, ...(screenshotOptions ?? {}) });
    if (!capture.ok) {
      return { ok: false, error: capture.error ?? "screenshot capture failed" };
    }
    const { response, audit } = await reviewer.review({
      imageBase64: capture.base64,
      focus,
      sessionDeadline,
    });
    return {
      ok: true,
      response: {
        ...response,
        reviewed_target: capture.target ?? null,
        page_errors: capture.pageErrors ?? [],
        console_errors: capture.consoleErrors ?? [],
      },
      audit,
    };
  };
}

export default VisionReviewer;
