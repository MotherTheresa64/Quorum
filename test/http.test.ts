import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

async function start(): Promise<{ server: Server; url: string }> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const { server, url } = await start();
  try {
    await fn(url);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("health reports readiness", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", flags: 0 });
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

test("a flag can be created, fetched, ramped and evaluated over HTTP", async () => {
  await withServer(async (url) => {
    const created = await fetch(`${url}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "checkout.v2", state: "ramp", rollout: 100_000, actor: "noah" }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).version, 1);

    const fetched = await fetch(`${url}/flags/checkout.v2`);
    assert.equal(fetched.status, 200);

    const patched = await fetch(`${url}/flags/checkout.v2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rollout: 50_000, actor: "noah" }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).version, 2);

    const evaluated = await fetch(`${url}/flags/checkout.v2/evaluate?subject=user-42`);
    assert.equal(evaluated.status, 200);
    const body = await evaluated.json();
    assert.equal(body.key, "checkout.v2");
    assert.equal(body.version, 2);
    assert.equal(typeof body.enabled, "boolean");
    assert.equal(typeof body.bucket, "number");
  });
});

test("the audit endpoint returns every change in order", async () => {
  await withServer(async (url) => {
    await fetch(`${url}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "audited", state: "off" }),
    });
    await fetch(`${url}/flags/audited`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "on" }),
    });

    const res = await fetch(`${url}/flags/audited/audit`);
    assert.equal(res.status, 200);
    const { entries } = await res.json();
    assert.deepEqual(entries.map((e: { action: string }) => e.action), ["create", "update"]);
    assert.deepEqual(entries.map((e: { seq: number }) => e.seq), [1, 2]);
  });
});

test("bad input is a 400 with a message, not a crash", async () => {
  await withServer(async (url) => {
    const badKey = await fetch(`${url}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "NOT VALID" }),
    });
    assert.equal(badKey.status, 400);
    assert.equal((await badKey.json()).error, "invalid");

    const notJson = await fetch(`${url}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal(notJson.status, 400);

    const noSubject = await fetch(`${url}/flags/anything/evaluate`);
    assert.equal(noSubject.status, 400);
    assert.match((await noSubject.json()).message, /subject/);
  });
});

test("unknown flags and routes are 404", async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/flags/missing`)).status, 404);
    assert.equal((await fetch(`${url}/flags/missing/audit`)).status, 404);
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    assert.equal((await fetch(`${url}/flags/nope`, { method: "DELETE" })).status, 404);
  });
});

test("the dashboard is served at the root as HTML", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /Quorum/);
    assert.match(html, /\/flags\//);
    assert.match(html, /evaluate/);
  });
});

test("a deleted flag is gone but was audited first", async () => {
  await withServer(async (url) => {
    await fetch(`${url}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "shortlived" }),
    });

    const deleted = await fetch(`${url}/flags/shortlived`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    assert.equal((await fetch(`${url}/flags/shortlived`)).status, 404);
    const audit = await fetch(`${url}/flags/shortlived/audit`);
    assert.equal(audit.status, 404, "audit requires the flag to still exist over HTTP");
  });
});
