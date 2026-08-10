import fs from "node:fs/promises";
import path from "node:path";
import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";
import { openLivePage, inspectPageSource } from "./page-inspector.js";
import { resolveSampling } from "./sampling-profiles.js";
import { NULL_PROMPT_TRACE } from "./prompt-trace.js";

export const PAGE_REGIONS_SCHEMA_ID = "page-regions";
export const PAGE_REGION_DETAIL_SCHEMA_ID = "page-region-detail";

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_TOKENS = 3072;
const DEFAULT_MAX_DETAIL_REGIONS = 4;
// Intersection-over-union above which a model-named region and a DOM element
// are treated as the same thing.
const MATCH_IOU = 0.35;

const slug = (value) =>
  String(value ?? "page")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "page";

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap <= 0) {
    return 0;
  }
  return overlap / (a.width * a.height + b.width * b.height - overlap);
};

/**
 * Understands a page the way a developer does: look at the whole thing, decide
 * what its parts are, then look at each part closely.
 *
 * A single `visual_review` call over a whole screenshot is the wrong shape for
 * this question. It returns one paragraph and a score, which is enough to
 * answer "does this look broken" and useless for "what am I supposed to build".
 * A social feed screenshot contains a nav rail, a composer, a repeated post
 * card and a suggestions column; asking one question about all of them at once
 * gets an answer about none of them.
 *
 * So this is a two-level subtask decomposition over the *image*:
 *
 *   1. survey — one vision call over the full screenshot: what regions exist,
 *      roughly where, and which of them are primary;
 *   2. detail — one vision call per primary region, over a **crop** of that
 *      region taken from the live page, with that region's DOM facts attached.
 *
 * The crop is what makes level 2 worth doing: the same model that produces a
 * vague paragraph about a whole page names the individual controls when it is
 * shown only the card. Region boxes come from the DOM when a model box matches
 * one (so the crop is pixel-exact) and from the model's normalized box when it
 * does not (so a region the DOM does not express as one element is still
 * reachable).
 */
export class PageUnderstanding {
  constructor(options = undefined) {
    this.client = options?.client ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.model =
      typeof options?.model === "string" && options.model.trim() ? options.model.trim() : null;
    this.timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1000, Math.floor(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    this.maxTokens = Number.isFinite(options?.maxTokens)
      ? Math.max(512, Math.floor(options.maxTokens))
      : DEFAULT_MAX_TOKENS;
    this.maxDetailRegions = Number.isFinite(options?.maxDetailRegions)
      ? Math.max(0, Math.floor(options.maxDetailRegions))
      : DEFAULT_MAX_DETAIL_REGIONS;
    this.artifactsDir = options?.artifactsDir ?? null;
    this.trace = options?.trace ?? NULL_PROMPT_TRACE;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
  }

  _log(message) {
    if (this.logger) {
      this.logger(`[page-understanding] ${message}`);
    }
  }

  /** One schema-bound vision call, traced, with a single retry. */
  async _visionCall({ schemaId, system, userText, imageBuffer, kind, label, sessionDeadline }) {
    const schema = this.schemaRegistry?.getSchema(schemaId) ?? null;
    if (!this.client || !this.model || !schema) {
      return { ok: false, error: "vision model or schema unavailable" };
    }
    const responseFormat = buildJsonSchemaResponseFormat(schema.definition, schemaId);
    const sampling = resolveSampling("vision");
    let budget = this.maxTokens;
    let lastError = "invalid-response";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remainingMs = Number.isFinite(sessionDeadline)
        ? Math.floor(sessionDeadline - Date.now())
        : null;
      if (remainingMs !== null && remainingMs <= 0) {
        return { ok: false, error: "session-timeout" };
      }
      const messages = [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                attempt === 1
                  ? userText
                  : `${userText}\n\nYour previous response was rejected (${lastError}). Return only schema-valid JSON.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${imageBuffer.toString("base64")}` },
            },
          ],
        },
      ];
      const startedAt = Date.now();
      let completion = null;
      let text = "";
      let error = null;
      try {
        completion = await this.client.createChatCompletion({
          model: this.model,
          messages,
          temperature: sampling.temperature,
          top_p: sampling.top_p,
          max_tokens: budget,
          response_format: responseFormat,
          timeoutMs:
            remainingMs === null
              ? this.timeoutMs
              : Math.max(1000, Math.min(this.timeoutMs, remainingMs)),
        });
        text = completion?.choices?.[0]?.message?.content ?? "";
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const validation = error ? null : this.schemaRegistry.validate(schemaId, text);
      await this.trace.record({
        kind,
        label,
        attempt,
        elapsedMs: Date.now() - startedAt,
        request: {
          model: this.model,
          messages,
          response_format: responseFormat,
          temperature: sampling.temperature,
          top_p: sampling.top_p,
          max_tokens: budget,
          samplingProfile: sampling.samplingProfile,
        },
        response: {
          text,
          reasoning:
            completion?.choices?.[0]?.message?.reasoning ??
            completion?.choices?.[0]?.message?.reasoning_content ??
            null,
          finish_reason: completion?.choices?.[0]?.finish_reason ?? null,
          usage: completion?.usage ?? null,
        },
        validation: validation
          ? { valid: Boolean(validation.valid), status: validation.status ?? null, error: validation.error ?? null }
          : null,
        error,
      });
      if (validation?.valid && validation.parsed) {
        return { ok: true, response: validation.parsed };
      }
      // Same failure mode vision-reviewer.js documents: a reasoning VLM can
      // spend the whole budget thinking and return empty content, which is a
      // budget problem, not a schema problem, and no retry at the same cap can
      // fix it.
      const reasoningTokens = Number(
        completion?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      );
      if (!text && completion?.choices?.[0]?.finish_reason === "length" && reasoningTokens > 0) {
        budget *= 4;
        lastError = `the model spent all ${reasoningTokens} tokens reasoning and returned no content`;
      } else {
        lastError = error ?? validation?.error ?? "schema validation failed";
      }
    }
    return { ok: false, error: lastError };
  }

  async _saveArtifact(name, buffer) {
    if (!this.artifactsDir || !buffer) {
      return null;
    }
    const file = path.join(this.artifactsDir, name);
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await fs.writeFile(file, buffer).catch(() => {});
    return file;
  }

  /**
   * Full two-level analysis of one page.
   *
   * @param {{absolutePath?:string|null, url?:string|null, focus?:string|null,
   *          sourcePath?:string|null, sessionDeadline?:number|null}} options
   */
  async understand({
    absolutePath = null,
    url = null,
    focus = null,
    sourcePath = null,
    sessionDeadline = null,
  } = {}) {
    let live = null;
    const label = slug(url ?? absolutePath ?? "page");
    try {
      live = await openLivePage({ absolutePath, url });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const digest = await live.digest();
      const full = await live.screenshot();
      const shotPath = await this._saveArtifact(path.join(label, "full.png"), full);

      // "As written" facts, when the target is a file we can also read. This is
      // the half a screenshot cannot give: class names and asset paths.
      const source =
        sourcePath ?? absolutePath
          ? await inspectPageSource(sourcePath ?? absolutePath).catch(() => null)
          : null;

      const survey = await this._visionCall({
        schemaId: PAGE_REGIONS_SCHEMA_ID,
        kind: "page-regions",
        label: `${label} survey`,
        sessionDeadline,
        imageBuffer: full,
        system: [
          "You are analysing a screenshot of a web page for a coding agent that has to reproduce it.",
          "Look only at the image. Divide the page into its distinct visual regions and say what each one is for.",
          "Boxes are fractions of the image (0..1), origin top-left. Approximate is fine; overlapping is not.",
          "Mark a region 'primary' only when reproducing the page depends on it. Chrome and decoration are 'secondary' or 'decorative'.",
          "Reply with ONLY the JSON object matching the schema. No prose, no fences.",
          "",
          "Exact JSON schema:",
          this.schemaRegistry.buildInstructionBlock(PAGE_REGIONS_SCHEMA_ID, { compact: true }),
        ].join("\n"),
        userText: [
          `Page: ${digest.title || "(untitled)"} at ${digest.target}`,
          `Rendered size: ${digest.viewport.width}x${digest.viewport.height}, document height ${digest.documentHeight}px.`,
          focus ? `Focus: ${focus}` : null,
          "Survey this page's regions.",
        ]
          .filter(Boolean)
          .join("\n"),
      });

      if (!survey.ok) {
        return {
          ok: true,
          response: {
            target: digest.target,
            screenshot: shotPath,
            rendered: digest,
            source,
            survey_error: survey.error,
            regions: [],
          },
        };
      }

      const chosen = this._selectRegions(survey.response.regions, digest, {
        width: digest.viewport.width,
        height: digest.viewport.height,
      });
      const details = [];
      for (const region of chosen.slice(0, this.maxDetailRegions)) {
        const crop = await live.screenshotRegion(region.pixelBox);
        if (!crop) {
          details.push({ region: region.name, error: "region crop failed" });
          continue;
        }
        const cropPath = await this._saveArtifact(
          path.join(label, `region-${slug(region.name)}.png`),
          crop,
        );
        const domFacts = region.dom
          ? [
              `DOM element: ${region.dom.selector}`,
              `contains ${region.dom.images} image(s), ${region.dom.links} link(s), ${region.dom.inputs} input(s), ${region.dom.buttons} button(s)`,
              region.dom.text ? `visible text: ${region.dom.text.slice(0, 500)}` : null,
            ]
              .filter(Boolean)
              .join("\n")
          : "No single DOM element matches this region; it was cropped from the model's own box.";
        const detail = await this._visionCall({
          schemaId: PAGE_REGION_DETAIL_SCHEMA_ID,
          kind: "page-region-detail",
          label: `${label} / ${region.name}`,
          sessionDeadline,
          imageBuffer: crop,
          system: [
            `You are analysing a CROP of one region ("${region.name}") of a web page, for a coding agent that has to reproduce it.`,
            "The image shows only that region. Name the individual elements inside it and what each one does.",
            "Say which values are dynamic — the data the server has to supply per item — using data-field names, not the example values you see.",
            "Reply with ONLY the JSON object matching the schema. No prose, no fences.",
            "",
            "Exact JSON schema:",
            this.schemaRegistry.buildInstructionBlock(PAGE_REGION_DETAIL_SCHEMA_ID, { compact: true }),
          ].join("\n"),
          userText: [
            `Region: ${region.name} — ${region.purpose}`,
            domFacts,
            focus ? `Overall focus for this page: ${focus}` : null,
            "Describe this region in detail.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        details.push({
          region: region.name,
          purpose: region.purpose,
          box: region.pixelBox,
          selector: region.dom?.selector ?? null,
          crop: cropPath,
          ...(detail.ok ? { detail: detail.response } : { error: detail.error }),
        });
      }

      return {
        ok: true,
        response: {
          target: digest.target,
          screenshot: shotPath,
          page_purpose: survey.response.page_purpose,
          layout: survey.response.layout ?? null,
          notes: survey.response.notes ?? [],
          rendered: {
            title: digest.title,
            viewport: digest.viewport,
            documentHeight: digest.documentHeight,
            styledElements: digest.styledElements,
            stylesheets: digest.stylesheets,
            headings: digest.headings,
            images: digest.images.slice(0, 10),
            forms: digest.forms,
            pageErrors: digest.pageErrors,
            consoleErrors: digest.consoleErrors,
            failedRequests: digest.failedRequests,
          },
          source,
          regions: details,
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await live.close();
    }
  }

  /**
   * Pairs each model-named region with the DOM element that occupies the same
   * space, so the crop is taken from real geometry rather than an estimate.
   * Regions the DOM does not express keep the model's own box.
   */
  _selectRegions(modelRegions, digest, viewport) {
    const domRegions = Array.isArray(digest?.regions) ? digest.regions : [];
    const used = new Set();
    const selected = [];
    const ranked = [...(modelRegions ?? [])].sort((a, b) => {
      const rank = (region) =>
        region.importance === "primary" ? 0 : region.importance === "secondary" ? 1 : 2;
      return rank(a) - rank(b);
    });
    for (const region of ranked) {
      const pixel = {
        x: Math.round((region.box?.x ?? 0) * viewport.width),
        y: Math.round((region.box?.y ?? 0) * viewport.height),
        width: Math.round((region.box?.width ?? 0) * viewport.width),
        height: Math.round((region.box?.height ?? 0) * viewport.height),
      };
      let best = null;
      let bestScore = 0;
      for (const candidate of domRegions) {
        if (used.has(candidate.selector)) {
          continue;
        }
        const score = iou(pixel, candidate.box);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      const matched = bestScore >= MATCH_IOU ? best : null;
      if (matched) {
        used.add(matched.selector);
      }
      selected.push({
        name: region.name,
        purpose: region.purpose,
        importance: region.importance ?? "primary",
        dom: matched,
        pixelBox: matched ? matched.box : pixel,
      });
    }
    return selected;
  }
}

/**
 * The action AgentSession wires as `pageUnderstand`. Returns the same
 * `{ok, response}` envelope the other optional capabilities use, so the session
 * feeds it back into the context graph without special-casing it.
 */
export function createPageUnderstandAction({
  restClient,
  schemaRegistry,
  model,
  workspaceRoot,
  artifactsDir = null,
  timeoutMs,
  maxDetailRegions,
  trace,
  logger,
} = {}) {
  if (!restClient || !schemaRegistry || !model) {
    return null;
  }
  const analyser = new PageUnderstanding({
    client: restClient,
    schemaRegistry,
    model,
    artifactsDir,
    timeoutMs,
    maxDetailRegions,
    trace,
    logger,
  });
  return async function pageUnderstandAction({
    relativePath = null,
    url = null,
    focus = null,
    sessionDeadline = null,
  } = {}) {
    const absolutePath = relativePath ? path.resolve(workspaceRoot, relativePath) : null;
    return analyser.understand({ absolutePath, url, focus, sessionDeadline });
  };
}

export default PageUnderstanding;
