import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error("Invalid PORT value; expected an integer from 1 to 65535.");
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

const configuredReplitHosts = [
  process.env.REPLIT_DEV_DOMAIN,
  ...(process.env.REPLIT_DOMAINS?.split(",") ?? []),
].filter(
  (host): host is string =>
    typeof host === "string" && /^[a-z0-9.-]+$/i.test(host.trim()),
).map((host) => host.trim());

// Never use allowedHosts: true on a server bound to 0.0.0.0.  An unrestricted
// Host header lets DNS-rebinding requests reach Vite's development server.
const allowedHosts = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  ".replit.dev",
  ".repl.co",
  ".replit.app",
  ...configuredReplitHosts,
];

const productionContentSecurityPolicy =
  "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self';";
const developmentContentSecurityPolicy =
  "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' ws: wss:;";

function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: "content-security-policy",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: context.server
                  ? developmentContentSecurityPolicy
                  : productionContentSecurityPolicy,
              },
              injectTo: "head",
            },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    contentSecurityPolicyPlugin(),
    mockupPreviewPlugin(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts,
  },
});
