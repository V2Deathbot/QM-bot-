import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import test, { after, before } from "node:test";
import app from "../src/app";

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
});

async function request(
  method: string,
  pathname: string,
  body?: string,
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(pathname, baseUrl);
    const request = httpRequest(
      parsed,
      {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
          origin: "https://attacker.example",
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: responseBody,
          });
        });
      },
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("API responses include baseline browser hardening without wildcard CORS", async () => {
  const response = await request("GET", "/api/healthz");

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["x-powered-by"], undefined);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(response.body), { status: "ok" });
});

test("unauthenticated refresh remains denied", async () => {
  const response = await request(
    "POST",
    "/api/bot/refresh",
    JSON.stringify({ requestedBy: "attacker" }),
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.match(response.body, /disabled/i);
});

test("detailed bot diagnostics are denied without probing providers", async () => {
  let providerRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerRequests += 1;
    return new Response("unexpected provider request", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  };

  try {
    const response = await request("GET", "/api/bot/status");

    assert.equal(response.statusCode, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.deepEqual(JSON.parse(response.body), {
      error:
        "Detailed diagnostics are available through the Discord administrator status command.",
    });
    assert.doesNotMatch(response.body, /trello|recovery|sync|config/i);
    assert.equal(providerRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized request bodies are rejected without an Express error page", async () => {
  const response = await request(
    "POST",
    "/api/bot/refresh",
    JSON.stringify({ payload: "x".repeat(17_000) }),
  );

  assert.equal(response.statusCode, 413);
  assert.deepEqual(JSON.parse(response.body), {
    error: "Request body too large",
  });
  assert.doesNotMatch(response.body, /stack|express/i);
});