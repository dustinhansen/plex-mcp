import { test, after } from "node:test";
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listenAddress, originAllowed, startHttp } from "#dist/lib/http.js";

const httpServer = await startHttp({
  port: 0, // ephemeral
  createMcpServer: () => new McpServer({ name: "plex-test", version: "0.0.0" }),
});
const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
after(() => httpServer.close());

/** Resolve when `wait` does, or reject once `signal` aborts. A test's timeout
 *  marks it failed without stopping its body, so a wait that never settles
 *  would leave the `finally` that closes its server unreachable, and the open
 *  listener would keep this file running. The tests' fetches take the same
 *  signal for the same reason. */
function unlessAborted(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  // An abort event never fires again for a signal that has already aborted.
  if (signal.aborted) return Promise.reject(signal.reason);
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([wait, aborted]);
}

test("http: /health returns 200 ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("http: POST /mcp handles initialize and returns JSON", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /application\/json/);
  const body = await res.json();
  assert.equal(body.result.serverInfo.name, "plex-test");
});

test("http: the per-request server is closed once after a POST completes", { timeout: 5000 }, async (t) => {
  let closes = 0;
  let closed!: () => void;
  const closedOnce = new Promise<void>((resolve) => { closed = resolve; });
  const counting = await startHttp({
    port: 0,
    createMcpServer: () => {
      const server = new McpServer({ name: "plex-test", version: "0.0.0" });
      const close = server.close.bind(server);
      server.close = async () => {
        closes += 1;
        closed();
        return close();
      };
      return server;
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(counting.address() as AddressInfo).port}/mcp`, {
      signal: t.signal,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    assert.equal(res.status, 200);
    await res.json();
    // The server closes it when the response closes, which can land just after the client has the body.
    await unlessAborted(closedOnce, t.signal);
    // A second close would land on a later turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closes, 1);
  } finally {
    counting.close();
  }
});

test("http: GET /mcp is 405, unknown path is 404", async () => {
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

/** Write `requestLine` and a few headers over a raw socket, since `fetch`
 *  refuses to send a target the URL parser cannot read and cannot choose the
 *  socket a request goes out on. `ahead` is written first on the same
 *  socket. Resolves with the whole response once the server closes the
 *  connection. A socket left without an answer would keep the shared server
 *  from closing, so it gives up after 2 seconds. */
function rawRequest(requestLine: string, ahead = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect((httpServer.address() as AddressInfo).port, "127.0.0.1");
    let response = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("no response within 2s")));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
    socket.write(`${ahead}${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

for (const target of ["//[::1", "http://[::1"]) {
  test(`http: a request-target the URL parser refuses (${target}) is 400 and the server stays up`, { timeout: 5000 }, async () => {
    const response = await rawRequest(`GET ${target} HTTP/1.1`);
    assert.match(response, /^HTTP\/1\.1 400 /);
    // The body arrives chunked: a hex size line, then that many bytes.
    assert.match(response, /\r\nTransfer-Encoding: chunked\r\n/i);
    const chunked = response.slice(response.indexOf("\r\n\r\n") + 4);
    const sizeEnd = chunked.indexOf("\r\n");
    const body = JSON.parse(chunked.slice(sizeEnd + 2, sizeEnd + 2 + parseInt(chunked.slice(0, sizeEnd), 16)));
    assert.deepEqual(body, { jsonrpc: "2.0", error: { code: -32600, message: "Invalid request target" }, id: null });
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
}

test("http: a per-request server whose close rejects does not end the process", { timeout: 5000 }, async (t) => {
  let closed!: () => void;
  const closeCalled = new Promise<void>((resolve) => { closed = resolve; });
  const failing = await startHttp({
    port: 0,
    createMcpServer: () => {
      const server = new McpServer({ name: "plex-test", version: "0.0.0" });
      server.close = async () => {
        closed();
        throw new Error("close failed");
      };
      return server;
    },
  });
  const fbase = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${fbase}/mcp`, {
      signal: t.signal,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    assert.equal(res.status, 200);
    await res.json();
    await unlessAborted(closeCalled, t.signal);
    // An unhandled rejection from the close would surface on a later turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fetch(`${fbase}/health`, { signal: t.signal })).status, 200);
  } finally {
    failing.close();
  }
});

test("http: oversized and malformed bodies are rejected, not buffered", async () => {
  const post = (body: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body,
    });
  const tooBig = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "a".repeat(2 << 20) } }));
  assert.equal(tooBig.status, 413);
  const malformed = await post("{not json");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

/** A POST to /mcp whose body is `size` bytes, for writing ahead of another
 *  request on 1 socket. */
function postOf(size: number): string {
  return `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${size}\r\n\r\n${"a".repeat(size)}`;
}

test("http: a 413 leaves its keep-alive socket able to carry the next request", { timeout: 5000 }, async () => {
  const response = await rawRequest("GET /health HTTP/1.1", postOf(2 << 20));
  assert.match(response, /^HTTP\/1\.1 413 [^]*\r\nHTTP\/1\.1 200 /);
});

test("http: a body past what the server will discard drops the socket and the server keeps serving", { timeout: 5000 }, async () => {
  // The drop reaches the client as a reset or a bare close, by timing. A
  // socket error carries a code, and rawRequest's own timeout does not.
  const response = await rawRequest("GET /health HTTP/1.1", postOf(16 << 20)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === undefined) throw error;
    return "";
  });
  assert.equal(response, "");
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("http: a configured pathSecret is REQUIRED — bare /mcp is refused", async () => {
  const secured = await startHttp({
    port: 0,
    pathSecret: "s3cr3t-t0ken",
    createMcpServer: () => new McpServer({ name: "plex-test", version: "0.0.0" }),
  });
  const sbase = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
  try {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    };
    // the whole point: knowing the hostname must not be enough
    assert.equal((await fetch(`${sbase}/mcp`, init)).status, 404, "bare /mcp must not bypass the secret");
    assert.equal((await fetch(`${sbase}/`, init)).status, 404);
    assert.equal((await fetch(`${sbase}/s3cr3t-t0ken/mcp`, init)).status, 200, "correct secret still works");
  } finally {
    secured.close();
  }
});

test("http: pathSecret admits any path containing the secret", async () => {
  const secretServer = await startHttp({
    port: 0,
    pathSecret: "s3cr3t-t0ken",
    createMcpServer: () => new McpServer({ name: "plex-test", version: "0.0.0" }),
  });
  const sbase = `http://127.0.0.1:${(secretServer.address() as AddressInfo).port}`;
  try {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    };
    // proxies mangle the mount path differently across versions — bare,
    // prefixed, and suffixed forms must all reach the MCP handler
    for (const path of ["/s3cr3t-t0ken", "/mcp/s3cr3t-t0ken", "/s3cr3t-t0ken/mcp"]) {
      const res = await fetch(`${sbase}${path}`, init);
      assert.equal(res.status, 200, path);
      assert.equal((await res.json()).result.serverInfo.name, "plex-test");
    }
    assert.equal((await fetch(`${sbase}/wrong-guess`, init)).status, 404);
  } finally {
    secretServer.close();
  }
});

test("http: a browser Origin other than loopback or the bound host is 403", async () => {
  const secured = await startHttp({
    port: 0,
    pathSecret: "s3cr3t-t0ken",
    createMcpServer: () => new McpServer({ name: "plex-test", version: "0.0.0" }),
  });
  const sbase = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
  const init = (origin: string | undefined) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(origin === undefined ? {} : { Origin: origin }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  try {
    // the secret does not excuse a foreign origin: the check runs first
    for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "not a url"]) {
      const res = await fetch(`${sbase}/s3cr3t-t0ken/mcp`, init(origin));
      assert.equal(res.status, 403, origin);
    }
    for (const origin of [undefined, "http://localhost:8627", "http://127.0.0.1:6274", "http://[::1]:8627", "null"]) {
      const res = await fetch(`${sbase}/s3cr3t-t0ken/mcp`, init(origin));
      assert.equal(res.status, 200, String(origin));
      assert.equal((await res.json()).result.serverInfo.name, "plex-test");
    }
  } finally {
    secured.close();
  }
});

test("http: the address the server is bound to counts as its own origin; a wildcard bind adds none", () => {
  assert.equal(originAllowed("http://192.0.2.10:8627", "192.0.2.10"), true);
  // The bound host is compared in the form URL normalises an Origin to
  assert.equal(originAllowed("http://[fe80::1]:8627", "fe80::0001"), true);
  assert.equal(originAllowed("http://[fe80::1]:8627", "[FE80::1]"), true);
  assert.equal(originAllowed("http://192.0.2.10:8627", "0.0.0.0"), false);
  assert.equal(originAllowed("http://0.0.0.0:8627", "0.0.0.0"), false);
  assert.equal(originAllowed("http://[::]:8627", "::"), false);
  assert.equal(originAllowed("http://localhost:6274", "0.0.0.0"), true);
});

test("http: startHttp listens on 127.0.0.1 unless given a host", async () => {
  assert.equal((httpServer.address() as AddressInfo).address, "127.0.0.1");
  const wildcard = await startHttp({
    port: 0,
    host: "0.0.0.0",
    createMcpServer: () => new McpServer({ name: "plex-test", version: "0.0.0" }),
  });
  try {
    assert.equal((wildcard.address() as AddressInfo).address, "0.0.0.0");
  } finally {
    wildcard.close();
  }
});

test("http: startHttp rejects a port in use with 1 line naming the address and the code", async () => {
  const holder = await startHttp({ port: 0, createMcpServer: () => { throw new Error("unused"); } });
  const { port } = holder.address() as AddressInfo;
  try {
    await assert.rejects(
      startHttp({ port, createMcpServer: () => { throw new Error("unused"); } }),
      { message: `cannot listen on 127.0.0.1:${port}: EADDRINUSE` },
    );
  } finally {
    holder.close();
  }
});

test("http: an error after listen is logged in 1 line and the server keeps serving", async (t) => {
  const server = await startHttp({ port: 0, createMcpServer: () => { throw new Error("unused"); } });
  try {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
    const error = Object.assign(new Error("too many open files"), { code: "EMFILE", syscall: "accept" });
    assert.doesNotThrow(() => server.emit("error", error));
    t.mock.restoreAll();
    assert.deepEqual(logged, [["http server error: EMFILE (accept)"]]);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("http: listenAddress defaults to port 8627 and leaves the host to startHttp", () => {
  assert.deepEqual(listenAddress({}), { port: 8627, host: undefined });
});

test("http: listenAddress reads PORT and MCP_HOST", () => {
  assert.deepEqual(listenAddress({ PORT: "9000", MCP_HOST: "0.0.0.0" }), { port: 9000, host: "0.0.0.0" });
  assert.equal(listenAddress({ MCP_HOST: "" }).host, undefined);
});

test("http: listenAddress treats an empty PORT as unset", () => {
  assert.equal(listenAddress({ PORT: "" }).port, 8627);
});

test("http: listenAddress takes PORT from 0 to 65535 and refuses anything else", () => {
  assert.equal(listenAddress({ PORT: "0" }).port, 0);
  assert.equal(listenAddress({ PORT: "65535" }).port, 65535);
  for (const bad of ["abc", "70000", "65536", "-1", "1.5", " 80", "0x50", "8e3"]) {
    assert.throws(() => listenAddress({ PORT: bad }), { message: `PORT must be an integer from 0 to 65535, not "${bad}"` });
  }
});
