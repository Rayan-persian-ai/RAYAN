/**
 * Tiny zod-like schema validator (no dependencies).
 * s.object({ q: s.string().min(1), n: s.number().int().optional() }).safeParse(x)
 */

export interface Issue {
  path: string;
  message: string;
}
export type ParseResult<T> = { success: true; data: T } | { success: false; issues: Issue[] };

export class ValidationError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

type Check<T> = (v: T) => string | null;

export abstract class Schema<T> {
  protected checks: Check<T>[] = [];
  /** @internal */
  abstract _parse(value: unknown, path: string, issues: Issue[]): T | undefined;

  safeParse(value: unknown): ParseResult<T> {
    const issues: Issue[] = [];
    const data = this._run(value, '', issues);
    return issues.length ? { success: false, issues } : { success: true, data: data as T };
  }
  parse(value: unknown): T {
    const r = this.safeParse(value);
    if (!r.success) throw new ValidationError(r.issues);
    return r.data;
  }
  /** @internal */
  _run(value: unknown, path: string, issues: Issue[]): T | undefined {
    const before = issues.length;
    const out = this._parse(value, path, issues);
    if (issues.length === before && out !== undefined) {
      for (const c of this.checks) {
        const msg = c(out);
        if (msg) issues.push({ path, message: msg });
      }
    }
    return out;
  }
  refine(fn: (v: T) => boolean, message = 'Invalid value'): this {
    this.checks.push((v) => (fn(v) ? null : message));
    return this;
  }
  optional(): Schema<T | undefined> {
    return new OptionalSchema(this);
  }
  default(value: T): Schema<T> {
    return new DefaultSchema(this, value);
  }
}

class OptionalSchema<T> extends Schema<T | undefined> {
  constructor(readonly inner: Schema<T>) {
    super();
  }
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (v === undefined || v === null) return undefined as T | undefined;
    return this.inner._run(v, path, issues);
  }
  override _run(value: unknown, path: string, issues: Issue[]) {
    return this._parse(value, path, issues);
  }
}

class DefaultSchema<T> extends Schema<T> {
  constructor(readonly inner: Schema<T>, readonly def: T) {
    super();
  }
  override _parse(v: unknown, path: string, issues: Issue[]) {
    return this.inner._run(v === undefined ? this.def : v, path, issues);
  }
}

function typeName(v: unknown) {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

export class StringSchema extends Schema<string> {
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (typeof v !== 'string') {
      issues.push({ path, message: `Expected string, got ${typeName(v)}` });
      return undefined;
    }
    return v;
  }
  min(n: number) {
    this.checks.push((v) => (v.length >= n ? null : `Must be at least ${n} characters`));
    return this;
  }
  max(n: number) {
    this.checks.push((v) => (v.length <= n ? null : `Must be at most ${n} characters`));
    return this;
  }
  regex(re: RegExp, message = `Must match ${re}`) {
    this.checks.push((v) => (re.test(v) ? null : message));
    return this;
  }
  url() {
    this.checks.push((v) => (/^https?:\/\/[^\s]+$/i.test(v) ? null : 'Must be an http(s) URL'));
    return this;
  }
}

export class NumberSchema extends Schema<number> {
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      issues.push({ path, message: `Expected number, got ${typeName(v)}` });
      return undefined;
    }
    return v;
  }
  int() {
    this.checks.push((v) => (Number.isInteger(v) ? null : 'Must be an integer'));
    return this;
  }
  min(n: number) {
    this.checks.push((v) => (v >= n ? null : `Must be >= ${n}`));
    return this;
  }
  max(n: number) {
    this.checks.push((v) => (v <= n ? null : `Must be <= ${n}`));
    return this;
  }
}

export class BooleanSchema extends Schema<boolean> {
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (typeof v !== 'boolean') {
      issues.push({ path, message: `Expected boolean, got ${typeName(v)}` });
      return undefined;
    }
    return v;
  }
}

export class LiteralSchema<T extends string | number | boolean> extends Schema<T> {
  constructor(readonly value: T) {
    super();
  }
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (v !== this.value) {
      issues.push({ path, message: `Expected ${JSON.stringify(this.value)}` });
      return undefined;
    }
    return v as T;
  }
}

export class EnumSchema<T extends string> extends Schema<T> {
  constructor(readonly values: readonly T[]) {
    super();
  }
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (typeof v !== 'string' || !(this.values as readonly string[]).includes(v)) {
      issues.push({ path, message: `Expected one of ${this.values.join(', ')}` });
      return undefined;
    }
    return v as T;
  }
}

export class ArraySchema<T> extends Schema<T[]> {
  constructor(readonly item: Schema<T>) {
    super();
  }
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (!Array.isArray(v)) {
      issues.push({ path, message: `Expected array, got ${typeName(v)}` });
      return undefined;
    }
    return v.map((x, i) => this.item._run(x, `${path}[${i}]`, issues) as T);
  }
  min(n: number) {
    this.checks.push((v) => (v.length >= n ? null : `Must contain at least ${n} items`));
    return this;
  }
  max(n: number) {
    this.checks.push((v) => (v.length <= n ? null : `Must contain at most ${n} items`));
    return this;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Shape = Record<string, Schema<any>>;
type Infer<S> = S extends Schema<infer T> ? T : never;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
type ObjectOut<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

export class ObjectSchema<S extends Shape> extends Schema<ObjectOut<S>> {
  private mode: 'strip' | 'strict' | 'passthrough' = 'strip';
  constructor(readonly shape: S) {
    super();
  }
  strict() {
    this.mode = 'strict';
    return this;
  }
  passthrough() {
    this.mode = 'passthrough';
    return this;
  }
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      issues.push({ path, message: `Expected object, got ${typeName(v)}` });
      return undefined;
    }
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = this.mode === 'passthrough' ? { ...src } : {};
    for (const [k, schema] of Object.entries(this.shape)) {
      const val = schema._run(src[k], path ? `${path}.${k}` : k, issues);
      if (val !== undefined) out[k] = val;
    }
    if (this.mode === 'strict') {
      for (const k of Object.keys(src)) if (!(k in this.shape)) issues.push({ path: path ? `${path}.${k}` : k, message: 'Unknown key' });
    }
    return out as ObjectOut<S>;
  }
}

export class RecordSchema<T> extends Schema<Record<string, T>> {
  constructor(readonly value: Schema<T>) {
    super();
  }
  override _parse(v: unknown, path: string, issues: Issue[]) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      issues.push({ path, message: `Expected object, got ${typeName(v)}` });
      return undefined;
    }
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = this.value._run(x, path ? `${path}.${k}` : k, issues) as T;
    return out;
  }
}

export class AnySchema extends Schema<unknown> {
  override _parse(v: unknown) {
    return v;
  }
  override _run(v: unknown) {
    return v;
  }
}

export const s = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  literal: <T extends string | number | boolean>(v: T) => new LiteralSchema(v),
  enum: <T extends string>(values: readonly T[]) => new EnumSchema(values),
  array: <T>(item: Schema<T>) => new ArraySchema(item),
  object: <S extends Shape>(shape: S) => new ObjectSchema(shape),
  record: <T>(value: Schema<T>) => new RecordSchema(value),
  any: () => new AnySchema(),
};

export type InferSchema<S> = Infer<S>;
