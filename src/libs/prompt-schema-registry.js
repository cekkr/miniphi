import fs from "fs";
import path from "path";
import { sanitizeJsonResponseText } from "./core-utils.js";
import { validateJsonAgainstSchema } from "./json-schema-utils.js";

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
        ? `${content.slice(0, maxLength)}…`
        : content;
    return ["```json", trimmed, "```"].join("\n");
  }

  /**
   * Validates a Phi response against the stored schema.
   * @param {string} id
   * @param {string} responseText
   * @returns {{ valid: boolean, errors?: string[], parsed?: any } | null}
   */
  validate(id, responseText) {
    const schema = this.getSchema(id);
    if (!schema) {
      return null;
    }
    return validateJsonAgainstSchema(schema.definition, responseText);
  }


}

export { stripJsonFences };
