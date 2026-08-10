import fs from "node:fs/promises";
import path from "node:path";
import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";
import { loadBootstrapProtocol } from "./project-guidelines.js";
import { resolveSampling } from "./sampling-profiles.js";
import { planOutputTokens } from "./model-limits.js";
import { NULL_PROMPT_TRACE } from "./prompt-trace.js";

export const HANDBOOK_SECTION_SCHEMA_ID = "project-handbook-section";
const DEFAULT_TIMEOUT_MS = 600000;

/**
 * Builds a project's own `AGENTS.md` from the construction protocol.
 *
 * The operator asked for `AGENTS.bootstrap.md` to be used as the reference for
 * creating an `AGENTS.md` in a project, and the honest reason it could not be
 * used directly is size: the protocol is 33 KB of normative requirements, and
 * the reference model runs an 8192-token window. Sending it whole leaves no
 * room for the project.
 *
 * So the protocol is applied the way it is written to be applied — as a
 * procedure, one section at a time:
 *
 *   1. a deterministic survey of the repository (files, manifests, scripts,
 *      tests, docs, entry points) that costs no tokens and cannot hallucinate;
 *   2. one bounded model call per section, carrying only that section's
 *      requirements from the protocol plus the survey;
 *   3. assembly, with every fact the model could not establish written into the
 *      handbook as an explicit gap rather than guessed.
 *
 * With no model configured it still emits a real, factual skeleton from the
 * survey alone — which is more useful than an eloquent handbook full of
 * invented commands.
 */

const SECTIONS = Object.freeze([
  {
    id: "mission",
    heading: "Mission and scope",
    requirement:
      "State the project's real name and purpose, its current maturity, and what adjacent concept or legacy name must not be confused with it. Say what the project explicitly is not.",
  },
  {
    id: "sources",
    heading: "Read order and sources of truth",
    requirement:
      "List the authoritative documents in priority order, linked, saying what each governs. Do not produce an unexplained list of filenames.",
  },
  {
    id: "principles",
    heading: "Essential principles and critical contracts",
    requirement:
      "Record the few non-negotiable principles that decide architecture and behavior, and the named invariants an adjacent edit is most likely to break. Each contract names the file or symbol that enforces it. Principles must be concrete enough to reject an incorrect implementation.",
  },
  {
    id: "architecture",
    heading: "Architecture and control flow",
    requirement:
      "Show the shortest useful path through the system as a flow (entry point -> ... -> storage), and name process boundaries, external services and storage ownership.",
  },
  {
    id: "source-map",
    heading: "Source map",
    requirement:
      "Give each meaningful file its own `###` heading as a relative Markdown link, then describe under it what that file owns, which changes belong there, its key symbols, what depends on it, and the mistake most commonly made in it. Do not flatten this into a bullet list of paths.",
  },
  {
    id: "workflows",
    heading: "Build, run, test and debug",
    requirement:
      "Exact, copyable commands taken from the surveyed manifests and scripts only. Never invent a flag, script, port or dependency. Say which commands mutate data or need network access.",
  },
  {
    id: "validation",
    heading: "Validation and test ownership",
    requirement:
      "Map each critical contract to the test file that validates it, and name the single command that runs the suite. Every project MUST have unit tests, and any user-facing surface (HTTP, CLI, GUI, rendered page) MUST also have an automated end-to-end check driving that real surface. Every check must produce a textual verdict — an exit code, a named assertion, a JSON report — so it can be read by a model with no vision; a screenshot is an attachment to a verdict, never the verdict. Contracts with no named test are listed as gaps, not described as covered.",
  },
  {
    id: "status",
    heading: "Status, known gaps and pitfalls",
    requirement:
      "Separate Shipped, Experimental, Known gap and Planned. Record recurring failure modes as durable rules with the invariant that prevents them, not as a chronology of incidents.",
  },
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".venv", "__pycache__", ".next",
  "coverage", "vendor", ".miniphi", ".cache",
]);

const MANIFESTS = [
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "Makefile", "CMakeLists.txt", "composer.json", "Gemfile",
];

const DOC_FILES = [
  "README.md", "CONTRIBUTING.md", "ARCHITECTURE.md", "ROADMAP.md",
  "SECURITY.md", "CHANGELOG.md", "AGENTS.md", "CLAUDE.md",
];

/**
 * Deterministic repository survey. No model, no guessing: everything here is
 * read off the filesystem, which is what makes the generated handbook checkable.
 */
export async function surveyRepository(root, { maxFiles = 400, maxDepth = 5 } = {}) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth || files.length >= maxFiles) {
      return;
    }
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        continue;
      }
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        const relative = path.relative(root, full).split(path.sep).join("/");
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          // unreadable files are still worth listing by name
        }
        files.push({ path: relative, bytes: size });
      }
    }
  };
  await walk(root, 0);

  const manifests = {};
  for (const name of MANIFESTS) {
    const file = path.join(root, name);
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (raw) {
      manifests[name] = raw.slice(0, 4000);
    }
  }
  const docs = [];
  for (const name of DOC_FILES) {
    const raw = await fs.readFile(path.join(root, name), "utf8").catch(() => null);
    if (raw) {
      docs.push({ name, bytes: raw.length, head: raw.slice(0, 800) });
    }
  }
  const scripts = (() => {
    try {
      return JSON.parse(manifests["package.json"] ?? "{}").scripts ?? {};
    } catch {
      return {};
    }
  })();
  const testFiles = files.filter((file) =>
    /(^|\/)(tests?|spec|__tests__|unit-tests[^/]*)\//i.test(file.path) ||
    /\.(test|spec)\.[a-z]+$/i.test(file.path),
  );
  // Only real directories: a top-level `README.md` listed as `README.md/` in a
  // generated source map is exactly the kind of invented fact this file exists
  // to avoid.
  const directories = [
    ...new Set(
      files
        .filter((file) => file.path.includes("/"))
        .map((file) => file.path.split("/")[0]),
    ),
  ].sort();
  const rootFiles = files.filter((file) => !file.path.includes("/")).map((file) => file.path);

  return {
    root,
    fileCount: files.length,
    truncated: files.length >= maxFiles,
    directories,
    rootFiles,
    files,
    manifests,
    scripts,
    docs,
    testFiles: testFiles.map((file) => file.path),
  };
}

/** The survey, rendered small enough to sit in one prompt beside a section. */
export function renderSurvey(survey, { maxFiles = 120 } = {}) {
  const lines = [
    `Repository root: ${survey.root}`,
    `Top-level directories: ${survey.directories.join(", ") || "(none)"}`,
    `Top-level files: ${(survey.rootFiles ?? []).join(", ") || "(none)"}`,
    `Tracked files surveyed: ${survey.fileCount}${survey.truncated ? " (truncated)" : ""}`,
  ];
  if (Object.keys(survey.scripts).length) {
    lines.push(
      `package.json scripts: ${Object.entries(survey.scripts)
        .map(([name, command]) => `${name} = ${command}`)
        .join(" | ")}`,
    );
  }
  for (const [name, raw] of Object.entries(survey.manifests)) {
    if (name !== "package.json") {
      lines.push(`${name} (first 400 chars): ${raw.slice(0, 400)}`);
    }
  }
  if (survey.docs.length) {
    lines.push(
      `Documents present: ${survey.docs.map((doc) => `${doc.name} (${doc.bytes} bytes)`).join(", ")}`,
    );
    for (const doc of survey.docs.slice(0, 3)) {
      lines.push(`--- ${doc.name} opening ---\n${doc.head}`);
    }
  }
  lines.push(
    `Test files (${survey.testFiles.length}): ${survey.testFiles.slice(0, 40).join(", ") || "none found — this is a gap, record it"}`,
  );
  lines.push(
    `Files:\n${survey.files
      .slice(0, maxFiles)
      .map((file) => `  ${file.path} (${file.bytes}B)`)
      .join("\n")}`,
  );
  return lines.join("\n");
}

/**
 * The factual skeleton produced with no model at all. Always heading-first, so
 * a fallback section is still a *section* rather than an orphan paragraph.
 */
function deterministicSection(section, survey) {
  return `## ${section.heading}\n\n${deterministicSectionBody(section, survey)}`;
}

function deterministicSectionBody(section, survey) {
  if (section.id === "workflows") {
    const entries = Object.entries(survey.scripts);
    return entries.length
      ? `Commands taken from \`package.json\`:\n\n${entries
          .map(([name, command]) => `- \`npm run ${name}\` — \`${command}\``)
          .join("\n")}`
      : "Unknown — verify before changing build or test workflows. No script manifest was found in the survey.";
  }
  if (section.id === "validation") {
    return survey.testFiles.length
      ? `Test files found by the survey:\n\n${survey.testFiles
          .slice(0, 40)
          .map((file) => `- \`${file}\``)
          .join("\n")}\n\nUnknown — verify which contract each file covers.`
      : "**Known gap:** the survey found no test files. Add unit tests, plus an automated end-to-end check for any user-facing surface, each producing a textual verdict (exit code or named assertion) so validation does not depend on anyone looking at a screen.";
  }
  if (section.id === "source-map") {
    return survey.directories.length
      ? `Top-level layout found by the survey (ownership not yet established):\n\n${survey.directories
          .map((dir) => `- \`${dir}/\``)
          .join("\n")}\n\nUnknown — verify each directory's ownership before relying on this map.`
      : "Unknown — verify the source layout.";
  }
  return `Unknown — verify before changing ${section.heading.toLowerCase()}.`;
}

export class AgentsBootstrapper {
  constructor(options = undefined) {
    this.client = options?.client ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.model =
      typeof options?.model === "string" && options.model.trim() ? options.model.trim() : null;
    this.contextLength = Number.isFinite(options?.contextLength) ? options.contextLength : null;
    this.maxTokens = Number.isFinite(options?.maxTokens) ? Math.floor(options.maxTokens) : 2000;
    this.timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1000, Math.floor(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    this.trace = options?.trace ?? NULL_PROMPT_TRACE;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.protocolPath = options?.protocolPath ?? null;
  }

  _log(message) {
    if (this.logger) {
      this.logger(`[bootstrap-agents] ${message}`);
    }
  }

  /**
   * The slice of the protocol relevant to one section. Sending the whole
   * protocol per section would spend the entire window on requirements the
   * section does not need.
   */
  _protocolSlice(protocolText, section) {
    const precision = /## Precision Rules([\s\S]*?)(?=\n## )/.exec(protocolText ?? "");
    return [
      "Requirements from the AGENTS.md construction protocol that apply to this section:",
      section.requirement,
      precision ? `\nGeneral precision rules:\n${precision[1].trim().slice(0, 1800)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async _writeSection({ section, survey, surveyText, protocolText, sessionDeadline }) {
    const schema = this.schemaRegistry?.getSchema(HANDBOOK_SECTION_SCHEMA_ID) ?? null;
    if (!this.client || !this.model || !schema) {
      return {
        section: section.id,
        markdown: deterministicSection(section, survey),
        unknowns: ["written without a model; every claim here is from the deterministic survey only"],
        fallback: true,
      };
    }
    const responseFormat = buildJsonSchemaResponseFormat(schema.definition, HANDBOOK_SECTION_SCHEMA_ID);
    const system = [
      `You are writing one section of a project's AGENTS.md: "${section.heading}".`,
      this._protocolSlice(protocolText, section),
      "",
      "You are given a survey of the repository produced by tooling. Every claim you make must come from it.",
      "Never invent a file, command, flag, script, port, dependency, symbol or test. When a fact is not in the survey, put it in `unknowns` instead of writing it.",
      "Write `markdown` starting at heading level 2 with the section heading, and keep it dense: an agent reads this to avoid repeating an investigation.",
      "Reply with ONLY the JSON object. No prose, no fences.",
      "",
      "Exact JSON schema:",
      this.schemaRegistry.buildInstructionBlock(HANDBOOK_SECTION_SCHEMA_ID, { compact: true }),
    ].join("\n");
    const user = `REPOSITORY SURVEY\n${surveyText}\n\nWrite the "${section.heading}" section (section id "${section.id}") as JSON now.`;

    const sampling = resolveSampling("summary");
    const budget = planOutputTokens({
      contextLength: this.contextLength,
      promptTokens: Math.ceil((system.length + user.length) / 4),
      hardCap: this.maxTokens,
    });
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
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
        max_tokens: budget.maxTokens,
        response_format: responseFormat,
        timeoutMs: Number.isFinite(sessionDeadline)
          ? Math.max(1000, Math.min(this.timeoutMs, sessionDeadline - Date.now()))
          : this.timeoutMs,
      });
      text = completion?.choices?.[0]?.message?.content ?? "";
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const validation = error
      ? null
      : this.schemaRegistry.validate(HANDBOOK_SECTION_SCHEMA_ID, text);
    await this.trace.record({
      kind: "handbook-section",
      label: section.id,
      elapsedMs: Date.now() - startedAt,
      request: {
        model: this.model,
        messages,
        response_format: responseFormat,
        temperature: sampling.temperature,
        top_p: sampling.top_p,
        max_tokens: budget.maxTokens,
        samplingProfile: sampling.samplingProfile,
      },
      response: {
        text,
        finish_reason: completion?.choices?.[0]?.finish_reason ?? null,
        usage: completion?.usage ?? null,
      },
      validation: validation
        ? { valid: Boolean(validation.valid), status: validation.status ?? null, error: validation.error ?? null }
        : null,
      error,
    });
    if (validation?.valid && validation.parsed) {
      return { ...validation.parsed, fallback: false };
    }
    this._log(`section "${section.id}" fell back: ${error ?? validation?.error ?? "invalid response"}`);
    return {
      section: section.id,
      markdown: deterministicSection(section, survey),
      unknowns: [
        `the model could not write this section (${error ?? validation?.error ?? "invalid response"}); the deterministic survey stands in for it`,
      ],
      fallback: true,
    };
  }

  /**
   * @param {{workspaceRoot:string, sections?:string[], sessionDeadline?:number|null}} options
   * @returns {Promise<{markdown:string, sections:Array, survey:object, fallbacks:number}>}
   */
  async build({ workspaceRoot, sections = null, sessionDeadline = null } = {}) {
    const survey = await surveyRepository(workspaceRoot);
    const surveyText = renderSurvey(survey);
    const protocol = await loadBootstrapProtocol({ file: this.protocolPath });
    const selected = sections?.length
      ? SECTIONS.filter((section) => sections.includes(section.id))
      : SECTIONS;

    const written = [];
    for (const section of selected) {
      this._log(`writing "${section.id}"…`);
      written.push(
        await this._writeSection({
          section,
          survey,
          surveyText,
          protocolText: protocol?.text ?? "",
          sessionDeadline,
        }),
      );
    }

    const projectName = path.basename(path.resolve(workspaceRoot));
    // A relative link is only useful when the protocol lives inside the
    // workspace; otherwise it becomes a ladder of `../` that resolves nowhere.
    const protocolRelative = protocol ? path.relative(workspaceRoot, protocol.path) : null;
    const protocolLabel = protocol
      ? protocolRelative && !protocolRelative.startsWith("..")
        ? protocolRelative
        : protocol.path
      : null;
    const header = [
      `# ${projectName} — agent handbook`,
      "",
      "The fast-access operational reference for agents working in this repository.",
      `Generated by MiniPhi \`bootstrap-agents\` from the AGENTS.md construction protocol${protocolLabel ? ` (\`${protocolLabel}\`)` : ""} plus a deterministic survey of the checked-out revision.`,
      "",
      "Every unverified claim is recorded as an explicit gap rather than guessed. Correct and extend this file as you work; a fact you had to rediscover belongs here.",
      "",
    ].join("\n");

    const body = written
      .map((entry) => {
        const unknowns = (entry.unknowns ?? []).filter(Boolean);
        const gaps = unknowns.length
          ? `\n\n> **Unverified in this section** — establish before relying on it:\n${unknowns
              .map((item) => `> - ${item}`)
              .join("\n")}`
          : "";
        return `${entry.markdown.trim()}${gaps}`;
      })
      .join("\n\n---\n\n");

    return {
      markdown: `${header}${body}\n`,
      sections: written,
      survey,
      fallbacks: written.filter((entry) => entry.fallback).length,
    };
  }
}

export { SECTIONS as HANDBOOK_SECTIONS };
export default AgentsBootstrapper;
