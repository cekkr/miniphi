import fs from "fs";
import path from "path";
import { sanitizeJsonResponseText } from "./core-utils.js";
import { validateJsonAgainstSchema, validateJsonObjectAgainstSchema } from "./json-schema-utils.js";

function stripJsonFences(payload) {
  return sanitizeJsonResponseText(payload);
}

export default class PromptSchemaRegistry {
  constructor(options = undefined) {
    this.schemaDir = options?.schemaDir
      ? path.resolve(options.schemaDir)
      : path.join(process.cwd(), "docs", "prompts");
    this.cache = new Map();
  }

  /**
   * Retrieve a parsed schema definition by id.
   * @param {string} id
   * @returns {{ id: string, definition: object, text: string, filePath: string } | null}
   */
  getSchema(id) {
    if (!id) {
      return null;
    }
    const normalized = id.trim().toLowerCase();
    if (this.cache.has(normalized)) {
      return this.cache.get(normalized);
    }
    const schemaPath = path.join(this.schemaDir, `${normalized}.schema.json`);
    let raw;
    try {
      raw = fs.readFileSync(schemaPath, "utf8");
    } catch {
      return null;
    }
    let definition;
    try {
      definition = JSON.parse(raw);
    } catch {
      return null;
    }
    const schema = {
      id: normalized,
      definition,
      text: JSON.stringify(definition, null, 2),
      filePath: schemaPath,
    };
    this.cache.set(normalized, schema);
    return schema;
  }

  /**
   * Generate a Markdown-safe schema block for prompts.
   * @param {string} id
   * @returns {string | null}
   */
  buildInstructionBlock(id, options = undefined) {
    const schema = this.getSchema(id);
    if (!schema) {
      return null;
    }
    const compact = options?.compact ?? false;
    const maxLength = Number.isFinite(options?.maxLength) && options.maxLength > 0 ? options.maxLength : null;
    const content = compact ? JSON.stringify(schema.definition) : schema.text;
    const trimmed =
      maxLength && content.length > maxLength
        ? `${content.slice(0, maxLength)}...`
        : content;
    return ["```json", trimmed, "```"].join("\n");
  }

  /** Build a JSON prompt contract with context-specific, schema-valid examples.
   * Templates describe output shape; they are never responses or fallbacks.
   * Callers own the phase semantics and still enforce their prompt budget.
   */
  buildResponseContract(id, { templates, instructions = [], enumConstraints = [] } = {}) {
    const schema = this.getSchema(id);
    if (!schema) throw new Error(`Missing schema ${id}`);
    const definition = structuredClone(schema.definition);
    if (!Array.isArray(enumConstraints) || enumConstraints.length > 16) throw new Error("Invalid response enum constraints");
    for (const constraint of enumConstraints) {
      if (!Array.isArray(constraint?.path) || !constraint.path.length || constraint.path.length > 12 || !Array.isArray(constraint.values) || !constraint.values.length || constraint.values.length > 64) throw new Error("Invalid response enum constraint");
      let target = definition;
      for (const key of constraint.path) {
        if (typeof key !== "string" || !target || !Object.hasOwn(target, key)) throw new Error("Unknown response enum constraint path");
        target = target[key];
      }
      if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("Response enum constraint must target a schema");
      if (constraint.values.some(value => !validateJsonAgainstSchema(target, JSON.stringify(value))?.valid)) throw new Error("Response enum constraint must narrow valid schema values");
      target.enum = [...new Set(constraint.values)];
    }
    if (!Array.isArray(templates) || !templates.length || templates.length > 3) {
      throw new Error("Response contract requires 1..3 templates");
    }
    if (!Array.isArray(instructions) || instructions.some(line => typeof line !== "string")) throw new Error("Response instructions must be strings");
    const names = new Set();
    for (const template of templates) {
      if (typeof template?.when !== "string" || !template.when.trim() || names.has(template.when)) throw new Error("Response templates need distinct nonempty conditions");
      names.add(template.when);
      const outcome = validateJsonObjectAgainstSchema(definition, JSON.stringify(template.response));
      if (outcome?.status !== "ok") throw new Error(`Invalid response template for ${id}: ${outcome?.error ?? "invalid JSON"}`);
    }
    return structuredClone({
      schema_id: schema.id,
      response_schema: definition,
      response_instructions: [
        "Return ONE response object matching a template and the exact schema, never this contract wrapper or the template list.",
        "Replace every <...> placeholder using the supplied context. Templates are output shapes, not facts or evidence. Array examples show item structure; use only as many items as needed within the schema bounds.",
        ...instructions,
      ],
      response_templates: templates,
    });
  }

  /**
   * Validates a Phi response against the stored schema and returns parse outcome metadata.
   * @param {string} id
   * @param {string} responseText
   * @returns {{ status: string, parsed: any, error: string | null, preambleDetected: boolean, validation: object | null } | null}
   */
  validateOutcome(id, responseText) {
    const schema = this.getSchema(id);
    if (!schema) {
      return null;
    }
    return validateJsonObjectAgainstSchema(schema.definition, responseText);
  }

  /**
   * Validates a Phi response against the stored schema.
   * @param {string} id
   * @param {string} responseText
   * @returns {{ valid: boolean, errors?: string[], parsed?: any, status?: string, error?: string | null, preambleDetected?: boolean } | null}
   */
  validate(id, responseText) {
    const outcome = this.validateOutcome(id, responseText);
    if (!outcome) {
      return null;
    }
    const validation =
      outcome.validation && typeof outcome.validation === "object"
        ? { ...outcome.validation }
        : {};
    if (typeof validation.valid !== "boolean") {
      validation.valid = outcome.status === "ok";
    }
    validation.status = outcome.status ?? validation.status ?? null;
    if (
      !validation.error &&
      typeof outcome.error === "string" &&
      outcome.error.trim().length > 0
    ) {
      validation.error = outcome.error.trim();
    }
    if (typeof validation.preambleDetected !== "boolean") {
      validation.preambleDetected = Boolean(outcome.preambleDetected);
    }
    if (validation.valid && outcome.parsed && validation.parsed === undefined) {
      validation.parsed = outcome.parsed;
    }
    return validation;
  }
}

export { stripJsonFences };
