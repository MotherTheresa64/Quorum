import test from "node:test";
import assert from "node:assert/strict";
import { Flags, ValidationError, NotFoundError, pickVariant } from "../src/flags.ts";
import { BUCKETS, bucketFor, percentToBuckets } from "../src/bucket.ts";

const T0 = 1_700_000_000_000;
const subjects = (n: number): string[] => Array.from({ length: n }, (_, i) => `user-${i}`);

test("a new flag defaults to off and evaluates as disabled", () => {
  const flags = new Flags();
  const flag = flags.create("checkout.v2", {}, "noah", T0);
  assert.equal(flag.state, "off");
  assert.equal(flag.version, 1);
  assert.deepEqual(flag.variants, [{ name: "on", weight: 100 }]);

  const result = flags.evaluate("checkout.v2", "user-1");
  assert.equal(result.enabled, false);
  assert.equal(result.reason, "flag_off");
  assert.equal(result.variant, null);
  assert.equal(result.version, 1);
});

test("an unknown flag is disabled rather than an error", () => {
  const flags = new Flags();
  const result = flags.evaluate("does.not.exist", "user-1");
  assert.deepEqual(result, {
    key: "does.not.exist",
    enabled: false,
    variant: null,
    reason: "flag_not_found",
    bucket: null,
    version: null,
  });
});

test("bucketing is stable across instances and runs", () => {
  const a = new Flags();
  const b = new Flags();
  a.create("beta", { state: "ramp", rollout: 50_000 });
  b.create("beta", { state: "ramp", rollout: 50_000 });

  for (const subject of subjects(50)) {
    assert.equal(a.evaluate("beta", subject).bucket, b.evaluate("beta", subject).bucket);
    assert.equal(a.evaluate("beta", subject).bucket, bucketFor("beta", subject));
  }
});

test("raising a rollout only ever adds subjects, never removes one", () => {
  const flags = new Flags();
  const population = subjects(2_000);
  flags.create("ramp", { state: "ramp", rollout: percentToBuckets(10) });

  // The rollout is raised on the *same* flag: that is the property under test.
  const included = (): Set<string> =>
    new Set(population.filter((s) => flags.evaluate("ramp", s).enabled));

  const at10 = included();
  flags.update("ramp", { rollout: percentToBuckets(50) });
  const at50 = included();
  flags.update("ramp", { rollout: BUCKETS });
  const at100 = included();

  for (const subject of at10) {
    assert.ok(at50.has(subject), `${subject} was enabled at 10% and must stay enabled at 50%`);
    assert.ok(at100.has(subject), `${subject} must stay enabled at 100%`);
  }
  assert.ok(at10.size < at50.size, "50% must enable strictly more subjects than 10%");
  assert.equal(at100.size, population.length, "100% enables everyone");
});

test("rollout of zero disables everyone", () => {
  const flags = new Flags();
  flags.create("dark", { state: "ramp", rollout: 0 });
  for (const subject of subjects(200)) {
    assert.equal(flags.evaluate("dark", subject).enabled, false);
  }
});

test("a 25% rollout lands close to 25% of a large population", () => {
  const flags = new Flags();
  flags.create("canary", { state: "ramp", rollout: percentToBuckets(25) });
  const population = subjects(10_000);
  const enabled = population.filter((s) => flags.evaluate("canary", s).enabled).length;
  const ratio = enabled / population.length;
  assert.ok(Math.abs(ratio - 0.25) < 0.02, `expected ~25%, got ${(ratio * 100).toFixed(2)}%`);
});

test("a 0.1% rollout is honoured, not rounded away", () => {
  const flags = new Flags();
  flags.create("tiny", { state: "ramp", rollout: percentToBuckets(0.1) });
  const population = subjects(20_000);
  const enabled = population.filter((s) => flags.evaluate("tiny", s).enabled).length;
  assert.ok(enabled > 0, "a small rollout must still reach somebody");
  assert.ok(enabled / population.length < 0.005, "and must not reach everybody");
});

test("enabled flags pick a variant from the declared set", () => {
  const flags = new Flags();
  flags.create("theme", {
    state: "on",
    variants: [
      { name: "control", weight: 50 },
      { name: "dark", weight: 50 },
    ],
  });
  const counts = new Map<string, number>();
  for (const subject of subjects(2_000)) {
    const { variant } = flags.evaluate("theme", subject);
    assert.ok(variant === "control" || variant === "dark");
    counts.set(variant, (counts.get(variant) ?? 0) + 1);
  }
  const dark = counts.get("dark") ?? 0;
  assert.ok(Math.abs(dark / 2_000 - 0.5) < 0.05, `expected an even split, got ${dark}/2000`);
});

test("variant selection is independent of the rollout bucket", () => {
  const flag = {
    key: "k",
    description: "",
    state: "on" as const,
    rollout: BUCKETS,
    variants: [
      { name: "a", weight: 100 },
      { name: "b", weight: 0 },
    ],
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  };
  for (const subject of subjects(100)) {
    assert.equal(pickVariant(flag, subject), "a", "a zero-weight variant is never chosen");
  }
});

test("update bumps the version and records who changed what", () => {
  const flags = new Flags();
  flags.create("search.v2", {}, "noah", T0);
  const updated = flags.update("search.v2", { state: "ramp", rollout: 10_000 }, "noah", T0 + 1_000);

  assert.equal(updated.version, 2);
  assert.equal(updated.state, "ramp");
  assert.equal(updated.rollout, 10_000);
  assert.equal(updated.createdAt, T0);
  assert.equal(updated.updatedAt, T0 + 1_000);

  const log = flags.audit("search.v2");
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((e) => [e.action, e.version, e.actor]), [
    ["create", 1, "noah"],
    ["update", 2, "noah"],
  ]);
  assert.equal(log[1].snapshot.rollout, 10_000, "the snapshot captures the post-change state");
});

test("audit entries are copied, so callers cannot rewrite history", () => {
  const flags = new Flags();
  flags.create("x.y", { description: "original" }, "noah", T0);
  const log = flags.audit();
  log[0].snapshot.description = "tampered";
  log[0].actor = "somebody else";
  assert.equal(flags.get("x.y")!.description, "original");
  assert.equal(flags.audit()[0].actor, "noah");
});

test("deleting a flag keeps its history", () => {
  const flags = new Flags();
  flags.create("gone", { state: "on" }, "noah", T0);
  assert.equal(flags.delete("gone"), true);
  assert.equal(flags.delete("gone"), false, "deleting twice reports no change");
  assert.equal(flags.get("gone"), null);
  assert.equal(flags.evaluate("gone", "user-1").reason, "flag_not_found");
  assert.equal(flags.audit("gone").length, 1, "the audit trail outlives the flag");
});

test("serialised state round-trips and evaluates identically", () => {
  const flags = new Flags();
  flags.create("a.b", { state: "ramp", rollout: 33_333 }, "noah", T0);
  flags.update("a.b", { rollout: 66_666 }, "noah", T0 + 1);

  const restored = Flags.fromJSON(flags.toJSON());
  for (const subject of subjects(100)) {
    assert.deepEqual(restored.evaluate("a.b", subject), flags.evaluate("a.b", subject));
  }
  assert.equal(restored.get("a.b")!.version, 2);
  assert.equal(restored.audit().length, 2);
});

test("flag keys are validated", () => {
  const flags = new Flags();
  for (const bad of ["", "A", "UPPER", "has space", "-leading", "x".repeat(65)]) {
    assert.throws(() => flags.create(bad), ValidationError, `expected ${JSON.stringify(bad)} to fail`);
  }
  assert.throws(() => flags.create("o"), ValidationError, "one character is too short");
  flags.create("ok.key_1-2", {});
});

test("rollout values must be integers inside the bucket range", () => {
  const flags = new Flags();
  assert.throws(() => flags.create("r1", { rollout: -1 }), ValidationError);
  assert.throws(() => flags.create("r2", { rollout: BUCKETS + 1 }), ValidationError);
  assert.throws(() => flags.create("r3", { rollout: 50.5 }), ValidationError);
});

test("variant weights must be coherent", () => {
  const flags = new Flags();
  assert.throws(() => flags.create("v1", { variants: [] }), ValidationError);
  assert.throws(
    () => flags.create("v2", { variants: [{ name: "a", weight: 60 }, { name: "b", weight: 20 }] }),
    ValidationError,
    "weights must sum to 100",
  );
  assert.throws(
    () => flags.create("v3", { variants: [{ name: "a", weight: 50 }, { name: "a", weight: 50 }] }),
    ValidationError,
    "duplicate variant names are ambiguous",
  );
  assert.throws(
    () => flags.create("v4", { variants: [{ name: "a", weight: -10 }, { name: "b", weight: 110 }] }),
    ValidationError,
  );
});

test("state and subject are validated", () => {
  const flags = new Flags();
  assert.throws(() => flags.create("s1", { state: "maybe" as never }), ValidationError);
  flags.create("s2", { state: "on" });
  assert.throws(() => flags.evaluate("s2", ""), ValidationError);
  assert.throws(() => flags.update("nope", { state: "on" }), NotFoundError);
  assert.throws(() => flags.update("s2", { rollout: -5 }), ValidationError);
});

test("create and update reject their respective misuse", () => {
  const flags = new Flags();
  flags.create("dup", {});
  assert.throws(() => flags.create("dup", {}), ValidationError);
  assert.throws(
    () => flags.update("dup", { variants: [{ name: "solo", weight: 99 }] }),
    ValidationError,
    "an updated variant set is validated just like a created one",
  );
});
