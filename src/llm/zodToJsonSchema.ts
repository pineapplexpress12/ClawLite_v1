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

  switch (typeName) {
    case 'ZodObject':
      return convertObject(def);
    case 'ZodString':
      return convertString(def);
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodArray':
      return { type: 'array', items: convertNode(def.type) };
    case 'ZodOptional':
      return convertNode(def.innerType);
    case 'ZodDefault':
      return { ...convertNode(def.innerType), default: def.defaultValue() };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: convertNode(def.valueType) };
    case 'ZodUnion':
      return { anyOf: (def.options as z.ZodTypeAny[]).map(convertNode) };
    case 'ZodLiteral':
      return { type: typeof def.value, const: def.value };
    case 'ZodNullable':
      return { ...convertNode(def.innerType), nullable: true };
    case 'ZodAny':
      return {};
    case 'ZodUnknown':
      return {};
    default:
      return {};
  }
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
