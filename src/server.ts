import { createServer, type IncomingMessage, type Server } from "node:http";
import { Flags, NotFoundError, ValidationError } from "./flags.ts";

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ValidationError("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("request body is not valid JSON");
  }
}

export function createApp(flags = new Flags()): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok", flags: flags.list().length });
      }

      // GET /flags
      if (req.method === "GET" && parts.length === 1 && parts[0] === "flags") {
        return send(res, 200, { flags: flags.list() });
      }

      // POST /flags
      if (req.method === "POST" && parts.length === 1 && parts[0] === "flags") {
        const body = await readJson(req);
        const key = String(body.key ?? "");
        const actor = String(body.actor ?? "api");
        const flag = flags.create(
          key,
          {
            description: body.description as string | undefined,
            state: body.state as never,
            rollout: body.rollout as number | undefined,
            variants: body.variants as never,
          },
          actor,
        );
        return send(res, 201, flag);
      }

      if (parts[0] !== "flags" || parts.length < 2) {
        return send(res, 404, { error: "not_found", path: url.pathname });
      }

      const key = decodeURIComponent(parts[1]);

      // GET /flags/:key
      if (req.method === "GET" && parts.length === 2) {
        const flag = flags.get(key);
        if (!flag) throw new NotFoundError(`no such flag: ${key}`);
        return send(res, 200, flag);
      }

      // PATCH /flags/:key
      if (req.method === "PATCH" && parts.length === 2) {
        const body = await readJson(req);
        const flag = flags.update(
          key,
          {
            description: body.description as string | undefined,
            state: body.state as never,
            rollout: body.rollout as number | undefined,
            variants: body.variants as never,
          },
          String(body.actor ?? "api"),
        );
        return send(res, 200, flag);
      }

      // DELETE /flags/:key
      if (req.method === "DELETE" && parts.length === 2) {
        if (!flags.delete(key)) throw new NotFoundError(`no such flag: ${key}`);
        return send(res, 204, null);
      }

      // GET /flags/:key/evaluate?subject=...
      if (req.method === "GET" && parts.length === 3 && parts[2] === "evaluate") {
        const subject = url.searchParams.get("subject");
        if (!subject) throw new ValidationError("query parameter 'subject' is required");
        return send(res, 200, flags.evaluate(key, subject));
      }

      // GET /flags/:key/audit
      if (req.method === "GET" && parts.length === 3 && parts[2] === "audit") {
        if (!flags.get(key)) throw new NotFoundError(`no such flag: ${key}`);
        return send(res, 200, { entries: flags.audit(key) });
      }

      return send(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: "invalid", message: err.message });
      if (err instanceof NotFoundError) return send(res, 404, { error: "not_found", message: err.message });
      return send(res, 500, { error: "internal", message: "unexpected failure" });
    }
  });
}

// Only listen when executed directly, so tests can import createApp without binding a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4000);
  createApp().listen(port, () => {
    console.log(`quorum listening on http://localhost:${port}`);
  });
}
