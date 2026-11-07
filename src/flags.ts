import { BUCKETS, bucketFor, fnv1a32 } from "./bucket.ts";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export type FlagState = "off" | "on" | "ramp";

export interface Variant {
  name: string;
  /** Relative weight. Weights across a flag must sum to 100. */
  weight: number;
}

export interface Flag {
  key: string;
  description: string;
  state: FlagState;
  /** Only meaningful while `state` is "ramp". 0 disables everyone, 100_000 enables everyone. */
  rollout: number;
  variants: Variant[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type Reason =
  | "flag_not_found"
  | "flag_off"
  | "flag_on"
  | "rollout_included"
  | "rollout_excluded";

export interface Evaluation {
  key: string;
  enabled: boolean;
  variant: string | null;
  reason: Reason;
  /** The subject's stable position on this flag, or null when the flag does not exist. */
  bucket: number | null;
  version: number | null;
}

export interface CreateOptions {
  description?: string;
  state?: FlagState;
  rollout?: number;
  variants?: Variant[];
}

export type UpdateOptions = Partial<CreateOptions>;

export interface AuditEntry {
  seq: number;
  at: number;
  actor: string;
  action: "create" | "update";
  flagKey: string;
  version: number;
  /** Full flag state after the change, so history can be replayed. */
  snapshot: Flag;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const STATES: readonly FlagState[] = ["off", "on", "ramp"];

function validateKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new ValidationError(
      "flag key must be 2-64 characters of lowercase letters, digits, dot, dash or underscore",
    );
  }
}

function validateVariants(variants: Variant[]): Variant[] {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new ValidationError("variants must be a non-empty array");
  }
  const seen = new Set<string>();
  let total = 0;
  for (const v of variants) {
    if (typeof v?.name !== "string" || v.name.trim() === "") {
      throw new ValidationError("every variant needs a non-empty name");
    }
    if (seen.has(v.name)) throw new ValidationError(`duplicate variant name: ${v.name}`);
    seen.add(v.name);
    if (!Number.isInteger(v.weight) || v.weight < 0) {
      throw new ValidationError(`variant ${v.name} needs a non-negative integer weight`);
    }
    total += v.weight;
  }
  if (total !== 100) {
    throw new ValidationError(`variant weights must sum to 100, received ${total}`);
  }
  return variants.map((v) => ({ name: v.name, weight: v.weight }));
}

function validateRollout(rollout: number): void {
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > BUCKETS) {
    throw new ValidationError(`rollout must be an integer between 0 and ${BUCKETS}`);
  }
}

function validateState(state: FlagState): void {
  if (!STATES.includes(state)) {
    throw new ValidationError(`state must be one of ${STATES.join(", ")}`);
  }
}

/** Weighted variant pick, salted separately from the bucket so the two do not correlate. */
export function pickVariant(flag: Flag, subjectId: string): string {
  const total = flag.variants.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0) return flag.variants[0].name;
  const point = fnv1a32(`${flag.key}:${subjectId}:variant`) % total;
  let acc = 0;
  for (const v of flag.variants) {
    acc += v.weight;
    if (point < acc) return v.name;
  }
  return flag.variants[flag.variants.length - 1].name;
}

export class Flags {
  private flags = new Map<string, Flag>();
  private log: AuditEntry[] = [];
  private seq = 0;

  create(key: string, opts: CreateOptions = {}, actor = "system", now = Date.now()): Flag {
    validateKey(key);
    if (this.flags.has(key)) throw new ValidationError(`flag already exists: ${key}`);

    const state = opts.state ?? "off";
    validateState(state);
    const rollout = opts.rollout ?? 0;
    validateRollout(rollout);

    const flag: Flag = {
      key,
      description: opts.description ?? "",
      state,
      rollout,
      variants: validateVariants(opts.variants ?? [{ name: "on", weight: 100 }]),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.flags.set(key, flag);
    this.record("create", flag, actor, now);
    return structuredClone(flag);
  }

  /** Patches a flag, bumps its version and appends an audit entry. */
  update(key: string, patch: UpdateOptions, actor = "system", now = Date.now()): Flag {
    const current = this.flags.get(key);
    if (!current) throw new NotFoundError(`no such flag: ${key}`);

    if (patch.state !== undefined) validateState(patch.state);
    if (patch.rollout !== undefined) validateRollout(patch.rollout);
    if (patch.description !== undefined && typeof patch.description !== "string") {
      throw new ValidationError("description must be a string");
    }

    const next: Flag = {
      ...current,
      description: patch.description ?? current.description,
      state: patch.state ?? current.state,
      rollout: patch.rollout ?? current.rollout,
      variants: patch.variants ? validateVariants(patch.variants) : current.variants,
      version: current.version + 1,
      updatedAt: now,
    };
    this.flags.set(key, next);
    this.record("update", next, actor, now);
    return structuredClone(next);
  }

  /** Removes a flag entirely. The audit log keeps the history. */
  delete(key: string): boolean {
    return this.flags.delete(key);
  }

  get(key: string): Flag | null {
    const flag = this.flags.get(key);
    return flag ? structuredClone(flag) : null;
  }

  list(state?: FlagState): Flag[] {
    const all = [...this.flags.values()];
    const filtered = state ? all.filter((f) => f.state === state) : all;
    return filtered
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((f) => structuredClone(f));
  }

  /**
   * The bucket depends only on the flag key and the subject id, never on the rollout
   * percentage. That is what makes ramping monotonic: raising 10% to 50% can only add
   * subjects, never remove one.
   */
  evaluate(key: string, subjectId: string): Evaluation {
    if (typeof subjectId !== "string" || subjectId.trim() === "") {
      throw new ValidationError("subjectId must be a non-empty string");
    }
    const flag = this.flags.get(key);
    if (!flag) {
      return {
        key,
        enabled: false,
        variant: null,
        reason: "flag_not_found",
        bucket: null,
        version: null,
      };
    }

    const bucket = bucketFor(flag.key, subjectId);

    if (flag.state === "off") {
      return { key, enabled: false, variant: null, reason: "flag_off", bucket, version: flag.version };
    }
    if (flag.state === "on") {
      return {
        key,
        enabled: true,
        variant: pickVariant(flag, subjectId),
        reason: "flag_on",
        bucket,
        version: flag.version,
      };
    }

    const included = bucket < flag.rollout;
    return {
      key,
      enabled: included,
      variant: included ? pickVariant(flag, subjectId) : null,
      reason: included ? "rollout_included" : "rollout_excluded",
      bucket,
      version: flag.version,
    };
  }

  audit(flagKey?: string): AuditEntry[] {
    const entries = flagKey ? this.log.filter((e) => e.flagKey === flagKey) : this.log;
    return structuredClone(entries);
  }

  /** Serialise every flag and the audit log, for backup or for replaying into a fresh instance. */
  toJSON(): { flags: Flag[]; audit: AuditEntry[] } {
    return { flags: this.list(), audit: this.audit() };
  }

  static fromJSON(data: { flags: Flag[]; audit?: AuditEntry[] }): Flags {
    const instance = new Flags();
    for (const flag of data.flags ?? []) {
      validateKey(flag.key);
      instance.flags.set(flag.key, { ...structuredClone(flag) });
    }
    instance.log = structuredClone(data.audit ?? []);
    instance.seq = instance.log.reduce((max, e) => Math.max(max, e.seq), 0);
    return instance;
  }

  private record(action: AuditEntry["action"], flag: Flag, actor: string, now: number): void {
    this.log.push({
      seq: ++this.seq,
      at: now,
      actor,
      action,
      flagKey: flag.key,
      version: flag.version,
      snapshot: structuredClone(flag),
    });
  }
}
