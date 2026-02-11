import { sanitizeJsonResponseText } from "./core-utils.js";

export function sanitizeResponseSchemaName(name) {
  if (!name) {
    return "miniphi-response";
  }
  const normalized = String(name)
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, 48) : "miniphi-response";
}

export function buildJsonSchemaResponseFormat(schemaDefinition, schemaName) {
  if (!schemaDefinition || typeof schemaDefinition !== "object") {
    return null;
  }
  return {
    type: "json_schema",
    json_schema: {
      name: sanitizeResponseSchemaName(schemaName ?? "miniphi-response"),
      schema: schemaDefinition,
    },
  };
}

export function validateJsonAgainstSchema(schemaDefinition, responseText, options = undefined) {
  if (!schemaDefinition || typeof schemaDefinition !== "object") {
    return null;
  }
  const sanitizeOptions = { ...(options ?? {}) };
  if (sanitizeOptions.allowPreamble === undefined) {
    sanitizeOptions.allowPreamble = false;
  }
  const stripped = sanitizeJsonResponseText(responseText ?? "", sanitizeOptions);
  if (!stripped) {
    return { valid: false, errors: ["Response body was empty."], preambleDetected: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    const preambleDetected = detectPreamble(responseText, sanitizeOptions, stripped);
    return {
      valid: false,
      errors: [
        `Response was not valid JSON (${error instanceof Error ? error.message : error}).`,
      ],
      preambleDetected,
    };
  }
  const errors = validateSchemaData(schemaDefinition, parsed, "$");
  if (errors.length > 0) {
    return { valid: false, errors, parsed, preambleDetected: false };
  }
  return { valid: true, parsed, preambleDetected: false };
}

function resolveSchemaValidationError(schemaValidation) {
  if (!schemaValidation || schemaValidation.valid !== false) {
    return null;
  }
  if (Array.isArray(schemaValidation.errors) && schemaValidation.errors.length > 0) {
    const firstError = schemaValidation.errors[0];
    if (typeof firstError === "string" && firstError.trim().length > 0) {
      return firstError.trim();
    }
  }
  return "schema validation failed";
}

export function classifyJsonSchemaValidation(schemaValidation) {
  const parsed = schemaValidation?.parsed ?? null;
  const preambleDetected = Boolean(schemaValidation?.preambleDetected);
  const parsedObject =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  if (!parsedObject) {
    if (preambleDetected) {
      return {
        status: "preamble_detected",
        parsed: null,
        error: "non-JSON preamble detected",
        preambleDetected: true,
      };
    }
    return {
      status: "invalid_json",
      parsed: null,
      error: "no valid JSON found",
      preambleDetected: false,
    };
  }
  const schemaError = resolveSchemaValidationError(schemaValidation);
  if (schemaError) {
    return {
      status: "schema_invalid",
      parsed: parsedObject,
      error: schemaError,
      preambleDetected: false,
    };
  }
  return {
    status: "ok",
    parsed: parsedObject,
    error: null,
    preambleDetected: false,
  };
}

export function validateJsonObjectAgainstSchema(
  schemaDefinition,
  responseText,
  options = undefined,
) {
  const validation = validateJsonAgainstSchema(schemaDefinition, responseText, options);
  const outcome = classifyJsonSchemaValidation(validation);
  return {
    ...outcome,
    validation,
  };
}

function detectPreamble(responseText, sanitizeOptions, stripped) {
  if (!responseText || sanitizeOptions?.allowPreamble) {
    return false;
  }
  const strict = stripped ?? sanitizeJsonResponseText(responseText ?? "", {
    ...(sanitizeOptions ?? {}),
    allowPreamble: false,
  });
  const salvage = sanitizeJsonResponseText(responseText ?? "", {
    ...(sanitizeOptions ?? {}),
    allowPreamble: true,
  });
  if (!salvage || salvage === strict) {
    return false;
  }
  try {
    JSON.parse(salvage);
    return true;
  } catch {
    return false;
  }
}

export function validateSchemaData(schema, value, pointer) {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  const errors = [];
  if (Array.isArray(schema.oneOf)) {
    const candidates = schema.oneOf;
    const matched = candidates.some((candidate) => {
      const result = validateSchemaData(candidate, value, pointer);
      return result.length === 0;
    });
    if (!matched) {
      errors.push(`${pointer}: no oneOf schema matched.`);
    }
    return errors;
  }
  if (Array.isArray(schema.anyOf)) {
    const candidates = schema.anyOf;
    const matched = candidates.some((candidate) => {
      const result = validateSchemaData(candidate, value, pointer);
      return result.length === 0;
    });
    if (!matched) {
      errors.push(`${pointer}: no anyOf schema matched.`);
    }
    return errors;
  }
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      errors.push(...validateSchemaData(candidate, value, pointer));
    }
    return errors;
  }
  const expectedTypes = normalizeTypes(schema.type);
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => matchesType(type, value))) {
    errors.push(
      `${pointer}: expected ${expectedTypes.join(" | ")}, received ${describeValue(value)}`,
    );
    return errors;
  }
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pointer}: value "${value}" is not in enum [${schema.enum.join(", ")}]`);
  }
  if (value === null && expectedTypes.includes("null")) {
    return errors;
  }
  if (isObjectSchema(schema)) {
    const obj = value ?? {};
    if (typeof obj !== "object" || Array.isArray(obj)) {
      errors.push(`${pointer}: expected object but received ${describeValue(value)}`);
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
        errors.push(...validateSchemaData(propertySchema, obj[key], `${pointer}.${key}`));
      }
    }
  }
  if (isArraySchema(schema)) {
    if (!Array.isArray(value)) {
      errors.push(`${pointer}: expected array but received ${describeValue(value)}`);
    } else {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        errors.push(`${pointer}: expected at least ${schema.minItems} items (found ${value.length}).`);
      }
      value.forEach((item, index) => {
        if (schema.items) {
          errors.push(...validateSchemaData(schema.items, item, `${pointer}[${index}]`));
        }
      });
    }
  }
  return errors;
}

function normalizeTypes(typeValue) {
  if (!typeValue) {
    return [];
  }
  if (Array.isArray(typeValue)) {
    return typeValue.flatMap((entry) => normalizeTypes(entry));
  }
  if (typeof typeValue === "string") {
    return [typeValue.toLowerCase()];
  }
  return [];
}

function matchesType(expected, value) {
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

function describeValue(value) {
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
    return `string("${value.slice(0, 24)}${value.length > 24 ? "..." : ""}")`;
  }
  return type;
}

function isObjectSchema(schema) {
  if (!schema) return false;
  if (schema.properties || schema.required) {
    return true;
  }
  const types = normalizeTypes(schema.type);
  return types.includes("object");
}

function isArraySchema(schema) {
  if (!schema) return false;
  if (schema.items) {
    return true;
  }
  const types = normalizeTypes(schema.type);
  return types.includes("array");
}
