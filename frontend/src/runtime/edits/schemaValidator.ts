/** Structural subset used by edit-contracts.json. Unsupported keywords fail closed. */
type Schema = { $defs: Record<string, Rule> };
type Rule = { $ref?: string; const?: unknown; enum?: unknown[]; oneOf?: Rule[]; type?: string;
  properties?: Record<string, Rule>; required?: string[]; additionalProperties?: boolean | Rule;
  items?: Rule; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; pattern?: string };

/** `$ref` hops followed when classifying a oneOf branch ahead of time; a longer (or cyclic) chain is simply not classified. */
const MAX_REF_HOPS = 8;
const hasOwn = Object.prototype.hasOwnProperty;

export function validateStructure(schema: Schema, name: string, value: unknown): void {
  const fail = (path: string): never => { throw new Error(`Invalid edit data: ${path}`); };
  /** Follows `$ref` (same precedence as `visit`) at most MAX_REF_HOPS times. undefined = not resolvable, so the caller must not skip. */
  const resolve = (rule: Rule): Rule | undefined => {
    let current = rule;
    for (let hops = 0; hops <= MAX_REF_HOPS; hops++) {
      if (!current.$ref) return current;
      const key = current.$ref.split('/').pop()!;
      if (!hasOwn.call(schema.$defs, key)) return undefined;
      current = schema.$defs[key];
    }
    return undefined;
  };
  /**
   * True ONLY when `visit(branch, data)` certainly throws, so the oneOf loop may skip the try/catch attempt (a thrown Error is by far the
   * most expensive part of validating a library). Anything not provable from the rule's own const / enum / type and a required const `kind`
   * (unresolvable or cyclic `$ref`, nested oneOf, optional `kind`, accessors, exotic objects, any exception while deciding) answers false,
   * which keeps the original try/catch path. It never changes `matches` or the final error: a skipped branch would have failed anyway.
   */
  const certainlyRejects = (branch: Rule, data: unknown): boolean => {
    try {
      const rule = resolve(branch);
      if (rule === undefined) return false;
      if ('const' in rule) return data !== rule.const;
      if (rule.enum) return Array.isArray(rule.enum) && !rule.enum.includes(data);
      if (rule.oneOf) return false;
      switch (rule.type) {
        case 'null': return data !== null;
        case 'boolean': return typeof data !== 'boolean';
        case 'string': return typeof data !== 'string';
        case 'integer': case 'number': return typeof data !== 'number';
        case 'array': return !Array.isArray(data);
        case 'object': {
          if (typeof data !== 'object' || data === null || Array.isArray(data)) return true;
          if (!Array.isArray(rule.required) || !rule.required.includes('kind') || !rule.properties || !hasOwn.call(rule.properties, 'kind')) return false;
          const kind = resolve(rule.properties.kind);
          if (kind === undefined || !('const' in kind)) return false;
          const own = Object.getOwnPropertyDescriptor(data, 'kind');
          if (own === undefined) return true; // required key is absent
          return own.enumerable === true && 'value' in own && own.value !== kind.const; // accessors / non-enumerable keys are left to `visit`
        }
        default: return false;
      }
    } catch { return false; }
  };
  const visit = (rule: Rule, data: unknown, path: string): void => {
    if (rule.$ref) return visit(schema.$defs[rule.$ref.split('/').pop()!] ?? fail(path), data, path);
    if ('const' in rule) { if (data !== rule.const) fail(path); return; }
    if (rule.enum) { if (!rule.enum.includes(data)) fail(path); return; }
    if (rule.oneOf) {
      let matches = 0;
      for (const branch of rule.oneOf) {
        if (certainlyRejects(branch, data)) continue;
        try { visit(branch, data, path); matches++; } catch { /* Another union member may match. */ }
      }
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
