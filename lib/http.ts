/**
 * Streamable HTTP front-end for the MCP server (stateless mode).
 *
 * Each POST /mcp gets a fresh McpServer + transport (no sessions). All
 * state lives in Plex, so statelessness is safe and survives restarts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIPv6 } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Cap on a single JSON-RPC request body. The endpoint is public, so an
 *  unbounded read is a free memory-exhaustion DoS. */
const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/** How much of an oversized body is read and thrown away so the 413 can go
 *  out on a socket that is still usable. Past this the socket is dropped
 *  with no answer, so a client cannot make the server read without end. */
const MAX_DISCARD_BYTES = 8 << 20; // 8 MiB

type OversizeError = Error & { tooLarge: true };

/** The body of `req` as text. Past `limit` it keeps nothing and rejects with
 *  an `OversizeError` once the body ends, so the 413 goes out after the
 *  client has finished sending and the keep-alive socket can carry its next
 *  request. Answering before the body ends would not do: a socket closed
 *  while the client is still sending is reset, and the reset can reach the
 *  client before the 413 does. Past `discardLimit` the socket is destroyed
 *  and the rejection is a plain error, since there is no one to answer. */
function readBody(req: IncomingMessage, limit: number, discardLimit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error): void => {
      settled = true;
      chunks = [];
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > discardLimit) {
        req.socket.destroy();
        fail(new Error("request body too large to read"));
      } else if (total > limit) {
        chunks = [];
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (settled) return;
      if (total > limit) {
        fail(Object.assign<Error, { tooLarge: true }>(new Error("request body too large"), { tooLarge: true }) satisfies OversizeError);
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!settled) fail(error);
    });
    req.on("close", () => {
      if (!settled) fail(new Error("request closed before its body ended"));
    });
  });
}

/** Hostnames a browser page may call from. The spec requires validating
 *  `Origin` against DNS rebinding: a rebound page's Origin names the
 *  attacker's domain, never one of these. Matching the request's own `Host`
 *  header would not do, because a rebound request's Host is that same domain. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "[::]"]);

/** `url`'s hostname in the form `URL` normalises it to: lowercased, IPv6
 *  bracketed and compressed. Undefined when it does not parse. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** True when `origin` may reach the server. No `Origin` is a non-browser
 *  client and passes. `null` (file:// and sandboxed pages) passes, since such
 *  a page cannot read the response and still needs the path secret. Otherwise
 *  the origin's hostname must be loopback or the specific address the server
 *  is bound to. A wildcard bind names no host of its own, so it adds nothing. */
export function originAllowed(origin: string | undefined, host: string): boolean {
  if (origin === undefined || origin === "null") return true;
  const hostname = hostnameOf(origin);
  if (hostname === undefined) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  const ownHost = hostnameOf(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}`);
  return ownHost !== undefined && !WILDCARD_HOSTS.has(ownHost) && hostname === ownHost;
}

/** The path of a request-target, or undefined when the URL parser refuses
 *  it. Node's HTTP parser accepts targets such as `//[::1` that `URL` throws
 *  on, so the raw target cannot be trusted to parse. */
function pathnameOf(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

/** Answer with a JSON-RPC error that names no request (`id: null`). */
function sendError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Where http mode listens, read from the environment: `PORT` (default
 *  8627) and `MCP_HOST` (unset leaves `startHttp`'s loopback default). A
 *  `PORT` that is not an integer from 0 to 65535 throws, naming the value. */
export function listenAddress(env: NodeJS.ProcessEnv): { port: number; host?: string } {
  const raw = env.PORT || "8627";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, not "${raw}"`);
  }
  return { port, host: env.MCP_HOST || undefined };
}

export function startHttp({ port, host = "127.0.0.1", createMcpServer, pathSecret }: {
  port: number;
  /** Listen address. Loopback by default, as the spec asks of a local
   *  server. The container image sets `0.0.0.0`. */
  host?: string;
  createMcpServer: () => McpServer;
  pathSecret?: string;
}): Promise<Server> {
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // close() drops the keep-alive sockets that are idle when it is called.
    // One still answering a request goes idle later and would hold a closing
    // server open for the keep-alive timeout, so drop it once it finishes.
    res.on("finish", () => {
      if (!httpServer.listening) setImmediate(() => httpServer.closeIdleConnections());
    });
    if (!originAllowed(req.headers.origin, host)) {
      sendError(res, 403, -32600, "Origin not allowed");
      return;
    }
    const pathname = pathnameOf(req.url);
    if (pathname === undefined) {
      sendError(res, 400, -32600, "Invalid request target");
      return;
    }
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    // When a pathSecret is configured it is REQUIRED. It is the only auth on
    // a write-capable endpoint. Matching anywhere in the path (rather than an
    // exact prefix) is deliberate: fronting proxies rewrite the mount path
    // inconsistently: some proxies strip the mount path, others forward it
    // verbatim.
    // Without a secret, only bare /mcp is served and the endpoint is
    // unauthenticated. index.js refuses that unless explicitly opted into.
    const isMcp = pathSecret ? pathname.includes(pathSecret) : pathname === "/mcp";
    if (!isMcp) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_BODY_BYTES, MAX_DISCARD_BYTES));
    } catch (error) {
      // A client that went away mid-body, or one readBody dropped past what
      // it will discard, has no one left to answer.
      if (req.socket.destroyed) return;
      const tooLarge = error instanceof Error && "tooLarge" in error && error.tooLarge === true;
      if (tooLarge) sendError(res, 413, -32600, "Request too large");
      else sendError(res, 400, -32700, "Parse error");
      return;
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      // A close that throws or rejects must not become an unhandled
      // rejection, which would end the process, so both are settled here.
      void Promise.allSettled([transport, server].map(async (closable) => closable.close())).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") console.error("mcp close failed:", result.reason);
        }
      });
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
  // The listener itself never returns a promise: a rejection from
  // `handleRequest` would otherwise be unhandled and end the process for
  // every client.
  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      console.error("http request failed:", error);
      if (!res.headersSent) sendError(res, 500, -32603, "Internal server error");
      else res.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    // The listener stays for the server's life. Before listen, a port in use
    // or a host that does not resolve is a setup mistake, so the rejection is
    // 1 line naming the address and the cause code, which the CLI prints in
    // place of a stack trace. After listen, an `error` with no listener would
    // be an uncaught exception, so one such as an EMFILE on accept would end
    // the process for every client. It is logged as 1 line instead.
    let started = false;
    httpServer.on("error", (error: NodeJS.ErrnoException) => {
      const cause = error.code ?? error.message;
      if (started) {
        console.error(`http server error: ${cause}${error.syscall ? ` (${error.syscall})` : ""}`);
        return;
      }
      const address = `${isIPv6(host) ? `[${host}]` : host}:${port}`;
      reject(new Error(`cannot listen on ${address}: ${cause}`, { cause: error }));
    });
    httpServer.listen(port, host, () => {
      started = true;
      resolve(httpServer);
    });
  });
}
