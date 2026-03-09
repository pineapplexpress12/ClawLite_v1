import type { z } from 'zod';

/**
 * Lightweight Zod-to-JSON-Schema converter.
 * Handles the subset of Zod types used by ClawLite tools.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convertNode(schema);
}

function convertNode(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  const typeName = def?.typeName as string;

  let result: Record<string, unknown>;

  switch (typeName) {
    case 'ZodObject':
      result = convertObject(def);
      break;
    case 'ZodString':
      result = convertString(def);
      break;
    case 'ZodNumber':
      result = { type: 'number' };
      break;
    case 'ZodBoolean':
      result = { type: 'boolean' };
      break;
    case 'ZodEnum':
      result = { type: 'string', enum: def.values };
      break;
    case 'ZodArray':
      result = { type: 'array', items: convertNode(def.type) };
      break;
    case 'ZodOptional':
      result = convertNode(def.innerType);
      break;
    case 'ZodDefault':
      result = { ...convertNode(def.innerType), default: def.defaultValue() };
      break;
    case 'ZodRecord':
      result = { type: 'object', additionalProperties: convertNode(def.valueType) };
      break;
    case 'ZodUnion':
      result = { anyOf: (def.options as z.ZodTypeAny[]).map(convertNode) };
      break;
    case 'ZodLiteral':
      result = { type: typeof def.value, const: def.value };
      break;
    case 'ZodNullable':
      result = { ...convertNode(def.innerType), nullable: true };
      break;
    case 'ZodAny':
      result = {};
      break;
    case 'ZodUnknown':
      result = {};
      break;
    default:
      result = {};
      break;
  }

  // Attach description if present (from .describe())
  if (def?.description && !result.description) {
    result.description = def.description;
  }

  return result;
}

function convertObject(def: any): Record<string, unknown> {
  const shape = def.shape?.() ?? {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const fieldDef = (value as any)?._def;
    const isOptional = fieldDef?.typeName === 'ZodOptional' || fieldDef?.typeName === 'ZodDefault';
    properties[key] = convertNode(value as z.ZodTypeAny);
    if (!isOptional) {
      required.push(key);
    }
  }

  const result: Record<string, unknown> = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    result.required = required;
  }

  return result;
}

function convertString(def: any): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'string' };
  const checks = def.checks as Array<{ kind: string; value?: unknown }> | undefined;
  if (checks) {
    for (const check of checks) {
      if (check.kind === 'min') result.minLength = check.value;
      if (check.kind === 'max') result.maxLength = check.value;
    }
  }
  return result;
}
