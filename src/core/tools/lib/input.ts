// Tolerant tool-input handling. Local models routinely send "true" instead of true, "10" instead of 10,
// null for omitted optionals, stringified arrays/objects, or camelCase/aliased parameter names.
// normalizeInput() repairs those, validateInput() then checks the result against the tool's JSON schema.

type Schema = Record<string, unknown>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function propsOf(schema: Schema): Record<string, Schema> {
  const p = schema.properties;
  return isObj(p) ? (p as Record<string, Schema>) : {};
}

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
}

function coerceValue(value: unknown, schema: Schema | undefined): unknown {
  if (value === null) return undefined;
  if (!schema) return value;
  const type = schema.type;
  switch (type) {
    case 'string': {
      let v: unknown = value;
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      if (typeof v === 'string' && Array.isArray(schema.enum) && !schema.enum.includes(v)) {
        // tolerate case / dash / underscore differences ("In-Progress" → in_progress)
        const key = (x: string) => x.toLowerCase().replace(/[-_\s]/g, '');
        const hit = (schema.enum as unknown[]).find((e) => typeof e === 'string' && key(e) === key(v as string));
        if (hit !== undefined) v = hit;
      }
      return v;
    }
    case 'integer':
    case 'number': {
      if (typeof value === 'string') {
        const t = value.trim();
        if (t === '') return undefined;
        const n = Number(t);
        if (Number.isFinite(n)) return type === 'integer' ? Math.trunc(n) : n;
        return value;
      }
      if (typeof value === 'number' && type === 'integer' && !Number.isInteger(value)) return Math.trunc(value);
      return value;
    }
    case 'boolean': {
      if (typeof value === 'string') {
        const t = value.trim().toLowerCase();
        if (t === 'true' || t === 'yes' || t === '1') return true;
        if (t === 'false' || t === 'no' || t === '0') return false;
        if (t === '') return undefined;
      }
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    case 'array': {
      let arr: unknown = value;
      if (typeof arr === 'string') {
        const t = arr.trim();
        if (t.startsWith('[')) {
          try { arr = JSON.parse(t); } catch { /* fall through */ }
        }
        if (typeof arr === 'string') arr = t === '' ? [] : [arr];
      }
      if (Array.isArray(arr)) {
        const items = isObj(schema.items) ? (schema.items as Schema) : undefined;
        return arr.map((v) => coerceValue(v, items)).filter((v) => v !== undefined);
      }
      return arr;
    }
    case 'object': {
      let obj: unknown = value;
      if (typeof obj === 'string') {
        const t = obj.trim();
        if (t.startsWith('{')) {
          try { obj = JSON.parse(t); } catch { /* fall through */ }
        }
      }
      if (isObj(obj)) return coerceObject(obj, schema);
      return obj;
    }
    default:
      return value;
  }
}

function coerceObject(raw: Record<string, unknown>, schema: Schema, aliases?: Record<string, string[]>): Record<string, unknown> {
  const props = propsOf(schema);
  const out: Record<string, unknown> = {};
  // 1. keep known keys as-is
  for (const [k, v] of Object.entries(raw)) {
    if (k in props) out[k] = v;
  }
  // 2. map unknown keys: explicit aliases, then camelCase → snake_case
  for (const [k, v] of Object.entries(raw)) {
    if (k in props) continue;
    let target: string | undefined;
    if (aliases) {
      for (const [canonical, list] of Object.entries(aliases)) {
        if (canonical in props && list.includes(k)) { target = canonical; break; }
      }
    }
    if (!target) {
      const s = snake(k);
      if (s in props) target = s;
    }
    if (target) {
      if (out[target] === undefined || out[target] === null) out[target] = v;
    } else {
      out[k] = v; // unknown: keep (tools ignore it)
    }
  }
  for (const [k, v] of Object.entries(out)) {
    const c = coerceValue(v, props[k]);
    if (c === undefined) delete out[k];
    else out[k] = c;
  }
  return out;
}

/** Repair common model mistakes. Never throws. */
export function normalizeInput(schema: Schema, raw: unknown, aliases?: Record<string, string[]>): Record<string, unknown> {
  let input: unknown = raw;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  if (!isObj(input)) return {};
  return coerceObject(input, schema, aliases);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkType(value: unknown, schema: Schema, path: string): string | null {
  const type = schema.type;
  const enumVals = Array.isArray(schema.enum) ? (schema.enum as unknown[]) : undefined;
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return `Invalid parameter "${path}": expected string, got ${typeName(value)}`;
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return `Invalid parameter "${path}": expected integer, got ${typeName(value)}`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `Invalid parameter "${path}": expected number, got ${typeName(value)}`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `Invalid parameter "${path}": expected boolean, got ${typeName(value)}`;
      break;
    case 'array': {
      if (!Array.isArray(value)) return `Invalid parameter "${path}": expected array, got ${typeName(value)}`;
      const items = isObj(schema.items) ? (schema.items as Schema) : undefined;
      if (items) {
        for (let i = 0; i < value.length; i++) {
          const e = checkType(value[i], items, `${path}[${i}]`);
          if (e) return e;
        }
      }
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `Invalid parameter "${path}": needs at least ${schema.minItems} item(s)`;
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `Invalid parameter "${path}": at most ${schema.maxItems} item(s) allowed`;
      break;
    }
    case 'object': {
      if (!isObj(value)) return `Invalid parameter "${path}": expected object, got ${typeName(value)}`;
      const e = validateObject(value, schema, path);
      if (e) return e;
      break;
    }
    default:
      break;
  }
  if (enumVals && !enumVals.includes(value)) {
    return `Invalid value for "${path}": must be one of ${enumVals.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  return null;
}

function validateObject(obj: Record<string, unknown>, schema: Schema, prefix: string): string | null {
  const props = propsOf(schema);
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const r of required) {
    if (obj[r] === undefined || obj[r] === null) {
      return `Missing required parameter "${prefix ? `${prefix}.${r}` : r}"`;
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    const ps = props[k];
    if (!ps || v === undefined) continue;
    const e = checkType(v, ps, prefix ? `${prefix}.${k}` : k);
    if (e) return e;
  }
  return null;
}

/** Returns an error message, or null when the (normalised) input satisfies the schema. */
export function validateInput(schema: Schema, input: Record<string, unknown>): string | null {
  return validateObject(input, schema, '');
}
