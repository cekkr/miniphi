import fs from "fs";
import path from "path";
import { sanitizeJsonResponseText } from "./core-utils.js";

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
    const stripped = stripJsonFences(responseText);
    if (!stripped) {
      return { valid: false, errors: ["Response body was empty."] };
    }
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch (error) {
      return {
        valid: false,
        errors: [
          `Response was not valid JSON (${error instanceof Error ? error.message : error}).`,
        ],
      };
    }
    const errors = this._validateData(schema.definition, parsed, "$");
    if (errors.length > 0) {
      return { valid: false, errors, parsed };
    }
    return { valid: true, parsed };
  }

  _validateData(schema, value, pointer) {
    if (!schema || typeof schema !== "object") {
      return [];
    }
    const errors = [];
    const expectedTypes = this._normalizeTypes(schema.type);
    if (expectedTypes.length > 0 && !expectedTypes.some((type) => this._matchesType(type, value))) {
      errors.push(
        `${pointer}: expected ${expectedTypes.join(
          " | ",
        )}, received ${this._describeValue(value)}`,
      );
      return errors;
    }
    if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      errors.push(`${pointer}: value "${value}" is not in enum [${schema.enum.join(", ")}]`);
    }
    if (this._isObjectSchema(schema)) {
      const obj = value ?? {};
      if (typeof obj !== "object" || Array.isArray(obj)) {
        errors.push(`${pointer}: expected object but received ${this._describeValue(value)}`);
        return errors;
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            errors.push(`${pointer}: missing required property "${key}"`);
          }
        }
      }
      if (schema.additionalProperties === false && schema.properties) {
        for (const key of Object.keys(obj)) {
          if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
            errors.push(`${pointer}: property "${key}" is not allowed.`);
          }
        }
      }
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          errors.push(...this._validateData(propertySchema, obj[key], `${pointer}.${key}`));
        }
      }
    }
    if (this._isArraySchema(schema)) {
      if (!Array.isArray(value)) {
        errors.push(`${pointer}: expected array but received ${this._describeValue(value)}`);
      } else {
        if (typeof schema.minItems === "number" && value.length < schema.minItems) {
          errors.push(`${pointer}: expected at least ${schema.minItems} items (found ${value.length}).`);
        }
        value.forEach((item, index) => {
          if (schema.items) {
            errors.push(
              ...this._validateData(schema.items, item, `${pointer}[${index}]`),
            );
          }
        });
      }
    }
    return errors;
  }

  _normalizeTypes(typeValue) {
    if (!typeValue) {
      return [];
    }
    if (Array.isArray(typeValue)) {
      return typeValue.flatMap((entry) => this._normalizeTypes(entry));
    }
    if (typeof typeValue === "string") {
      return [typeValue.toLowerCase()];
    }
    return [];
  }

  _matchesType(expected, value) {
    if (expected === "null") {
      return value === null;
    }
    if (expected === "array") {
      return Array.isArray(value);
    }
    if (expected === "object") {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    if (expected === "integer") {
      return Number.isInteger(value);
    }
    if (expected === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    return typeof value === expected;
  }

  _describeValue(value) {
    if (value === null) {
      return "null";
    }
    if (Array.isArray(value)) {
      return `array(length=${value.length})`;
    }
    const type = typeof value;
    if (type === "object") {
      return "object";
    }
    if (type === "string") {
      return `string("${value.slice(0, 24)}${value.length > 24 ? "…" : ""}")`;
    }
    return type;
  }

  _isObjectSchema(schema) {
    if (!schema) return false;
    if (schema.properties || schema.required) {
      return true;
    }
    const types = this._normalizeTypes(schema.type);
    return types.includes("object");
  }

  _isArraySchema(schema) {
    if (!schema) return false;
    if (schema.items) {
      return true;
    }
    const types = this._normalizeTypes(schema.type);
    return types.includes("array");
  }
}

export { stripJsonFences };
