// VERBATIM COPY of frontend/src/runtime/edits/schemaValidator.ts as of git HEAD 6caa3c09 (blob 7d5532b0c734355cb3a96b6f4ee8acc99cab2add, sha256 94ad92d6f271f967810c5bf70f527a8ad9702e579c4124f8acff249c8a773b9d).
// This is the reference (pre-U1, exception-based oneOf) implementation for the differential tests. The ONLY edit is the exported function name
// (validateStructure -> validateStructureLegacy); schemaValidatorEquivalence.test.ts reverses that rename and checks the sha256 above. Never edit the body.
//--- legacy body begins on the next line ---
/** Structural subset used by edit-contracts.json. Unsupported keywords fail closed. */
type Schema = { $defs: Record<string, Rule> };
type Rule = { $ref?: string; const?: unknown; enum?: unknown[]; oneOf?: Rule[]; type?: string;
  properties?: Record<string, Rule>; required?: string[]; additionalProperties?: boolean | Rule;
  items?: Rule; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; pattern?: string };

export function validateStructureLegacy(schema: Schema, name: string, value: unknown): void {
  const fail = (path: string): never => { throw new Error(`Invalid edit data: ${path}`); };
  const visit = (rule: Rule, data: unknown, path: string): void => {
    if (rule.$ref) return visit(schema.$defs[rule.$ref.split('/').pop()!] ?? fail(path), data, path);
    if ('const' in rule) { if (data !== rule.const) fail(path); return; }
    if (rule.enum) { if (!rule.enum.includes(data)) fail(path); return; }
    if (rule.oneOf) {
      let matches = 0;
      for (const branch of rule.oneOf) { try { visit(branch, data, path); matches++; } catch { /* Another union member may match. */ } }
      if (matches !== 1) fail(path);
      return;
    }
    switch (rule.type) {
      case 'null': if (data !== null) fail(path); break;
      case 'boolean': if (typeof data !== 'boolean') fail(path); break;
      case 'string': {
        if (typeof data !== 'string') return fail(path);
        const size = Array.from(data).length;
        if (size < (rule.minLength ?? 0) || size > (rule.maxLength ?? Infinity)
          || (rule.pattern && new RegExp(rule.pattern).exec(data)?.[0] !== data)) fail(path);
        // JSON wire strings must be Unicode scalars, rather than isolated UTF-16 surrogates.
        for (const char of data) { const cp = char.codePointAt(0)!; if (cp >= 0xd800 && cp <= 0xdfff) fail(path); }
        break;
      }
      case 'integer': case 'number':
        if (typeof data !== 'number' || !Number.isFinite(data) || (rule.type === 'integer' && !Number.isSafeInteger(data))
          || data < (rule.minimum ?? -Infinity) || data > (rule.maximum ?? Infinity)
          || (rule.exclusiveMinimum !== undefined && data <= rule.exclusiveMinimum)) fail(path);
        break;
      case 'array':
        if (!Array.isArray(data)) return fail(path);
        if (data.length < (rule.minItems ?? 0) || data.length > (rule.maxItems ?? Infinity)) fail(path);
        data.forEach((item, index) => visit(rule.items ?? fail(path), item, `${path}[${index}]`)); break;
      case 'object': {
        if (typeof data !== 'object' || data === null || Array.isArray(data)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(data))) return fail(path);
        const object = data as Record<string, unknown>;
        for (const key of rule.required ?? []) if (!Object.prototype.hasOwnProperty.call(object, key)) fail(`${path}.${key}`);
        for (const [key, item] of Object.entries(object)) {
          for (const char of key) { const cp = char.codePointAt(0)!; if (cp >= 0xd800 && cp <= 0xdfff) fail(path); }
          const property = Object.prototype.hasOwnProperty.call(rule.properties ?? {}, key) ? rule.properties![key] : rule.additionalProperties;
          if (property === false || property === undefined) fail(`${path}.${key}`);
          else if (property !== true) visit(property, item, `${path}.${key}`);
        }
        break;
      }
      default: fail(path);
    }
  };
  visit(schema.$defs[name] ?? fail(name), value, name);
}
