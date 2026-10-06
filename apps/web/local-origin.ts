import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { Plugin } from "vite";

const loopbackHost = /^(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

function canonicalNavigation(request: IncomingMessage): string | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (!request.url?.startsWith("/")) return null;
  const path = request.url.split("?", 1)[0];
  if (path === "/v1" || path?.startsWith("/v1/") || path === "/openapi.json") return null;
  const navigation = request.headers["sec-fetch-mode"] === "navigate"
    || request.headers.accept?.includes("text/html");
  if (!navigation || !loopbackHost.test(request.headers.host ?? "")) return null;

  const protocol = request.socket instanceof TLSSocket ? "https:" : "http:";
  let origin: URL;
  try { origin = new URL(`${protocol}//${request.headers.host}`); }
  catch { return null; }
  origin.hostname = "localhost";
  return `${origin.origin}${request.url}`;
}

function redirectNavigation(request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const destination = canonicalNavigation(request);
  if (!destination) return next();
  response.writeHead(307, { location: destination, "cache-control": "no-store" });
  response.end();
}

/** Keep local auth, passkey RP IDs and callbacks on the configured localhost origin. */
export function localOrigin(): Plugin {
  return {
    name: "gitknot-canonical-local-origin",
    configureServer(server) { server.middlewares.use(redirectNavigation); },
    configurePreviewServer(server) { server.middlewares.use(redirectNavigation); },
  };
}
