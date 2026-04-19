---
id: pyr-klq
title: Proxy bridge is byte-level tee, not JSON-RPC demux — request-ID collision on shared Pyright
status: open
type: bug
priority: 0
---


## Context

`createSocketBridge` in `packages/pyright-mcp/src/proxy.ts:88-125` doesn't proxy — it tees. Every client's stdin is spliced onto Pyright's single stdin, and every byte Pyright writes back is cloned to every connected client. There's no JSON-RPC parsing, no ID translation, no response routing.

```ts
const server = net.createServer((client) => {
    clients.add(client);
    client.on('data', (data) => pyrightProcess.stdin!.write(data));
    ...
});
pyrightProcess.stdout!.on('data', (data) => {
    for (const client of clients) client.write(data);
});
```

This worked in pyr-084 (the proxy shipping task) because only two clients existed — Claude Code's LSP plugin and the MCP tool — and their request patterns rarely overlapped in time. pyr-noe introduced a third client (the PostToolUse enrichment hook connecting directly to the socket) that fires on every Read. The race window between client-local request-ID counters is no longer negligible.

## The bug

`vscode-jsonrpc`'s `MessageConnection` assigns request IDs locally, starting at 0 and incrementing. Every client — LSP plugin, MCP, hook — runs its own counter. When two clients send request ID 1 within an overlapping window:

1. Pyright receives two interleaved requests on its stdin, both with ID 1
2. Pyright processes both, emits two responses, both with ID 1
3. The bridge broadcasts both responses to every client
4. Each client's `MessageConnection` sees a response for ID 1, matches it against its local pending map, and **resolves its own promise with whichever response's bytes parsed first** — possibly the other client's payload

Consequences, in order of visibility:
- A client's `sendRequest` resolves with the wrong-typed payload (silent data corruption — `T` comes back as a `U`)
- A client's second response arrives after it already resolved; `MessageConnection` logs "no matching request" and drops it (only visible in verbose logs)
- Pyright's stdin interleaves two clients' bytes mid-message if both write simultaneously (catastrophic — breaks the `Content-Length` framing)

The stdin-interleaving failure mode is currently masked by Node's `net.Socket` writes landing as single chunks below the pipe-buffer threshold, but nothing in the design guarantees it. Under load it will corrupt messages.

## The correct design

The proxy must be a JSON-RPC-aware multiplexer, not a byte-level tee. Standard pattern:

- **Parse** each client's stdin as LSP messages (`Content-Length` header + JSON body) using the same `StreamMessageReader` pattern used by the MCP-mode handshake in `proxy.ts:288-331`
- **For requests** (`{jsonrpc, id, method, params}`): allocate a globally-unique proxy ID, record `proxyId → {clientSocket, originalId, method}`, substitute the proxy ID on the forwarded message, write to Pyright's stdin via a single serialized `StreamMessageWriter`
- **For responses from Pyright** (`{jsonrpc, id, result|error}`): look up the proxy ID, substitute the client's original ID back, write to **only** that client
- **For notifications** (no `id`, e.g., `textDocument/publishDiagnostics`, `initialized`, `didOpen`): genuinely broadcast is correct for server→client ones (diagnostics fan out), and forwarding to Pyright is correct for client→server ones (didOpen is a Pyright-global fact)
- **For server-initiated requests** (Pyright → client, e.g., `workspace/configuration`, `window/showMessage`): these have IDs too; record an inverse mapping keyed by the Pyright-assigned ID, route to a designated "primary" client (first live client, or the one that last sent `initialize`). When that client responds, translate back to Pyright's original ID.

Serialization requirement: Pyright's stdin must be written by exactly one writer to preserve `Content-Length` framing. Use a single `StreamMessageWriter` owned by the bridge, with each inbound client message enqueued through an async mutex or a channel so two clients never partial-write.

## Reproduction

No test currently exercises three concurrent clients. To reproduce:

1. Spawn `proxy --lsp` (PID A)
2. Spawn `proxy --mcp` (PID B) against the same `PYRIGHT_PROXY_STATE_DIR`
3. Open a third raw socket connection (PID C) against `pyright.sock`
4. From all three, send `workspace/symbol` requests with `query: 'X'` / `'Y'` / `'Z'` within the same tick
5. Assert each client receives the response matching its own query

The current tee bridge will sometimes route Y's response to X. A demux bridge will always route correctly.

A unit test for the demux logic itself (no Pyright) should feed crafted JSON-RPC messages from two mock clients and assert the bridge routes responses to the correct client socket.

## Requirements

R1. Replace `createSocketBridge`'s byte-level tee with a JSON-RPC-aware multiplexer.
R2. Rewrite client request IDs to globally-unique proxy IDs before forwarding; rewrite Pyright responses back to the client's original ID.
R3. Route response messages to **only** the originating client, not all connected clients.
R4. Broadcast remains correct for server-to-client notifications (diagnostics, `window/showMessage`, etc.).
R5. Serialize writes to Pyright's stdin so two clients never corrupt each other's `Content-Length` framing.
R6. Handle server-initiated requests (Pyright → client) with an inverse ID mapping.
R7. All existing tests pass (proxy.test.ts, mcp-server.test.ts, hooks tests from pyr-noe).
R8. New test: three concurrent clients make overlapping `workspace/symbol` requests with distinct queries; each receives the correct response.
R9. New test: a mock "Pyright" emits a server-initiated request; the correct client receives it and its response is routed back correctly.

## Success Criteria

- [ ] `createSocketBridge` replaced by a JSON-RPC-aware multiplexer in `proxy.ts`
- [ ] Client→Pyright: request IDs translated; writes serialized onto Pyright's stdin via a single `StreamMessageWriter`
- [ ] Pyright→Client: responses routed only to the originating client by proxy-ID lookup
- [ ] Notifications still fan out correctly (diagnostics reach every connected client; `didOpen` from any client reaches Pyright)
- [ ] Server-initiated requests routed to a designated client; their responses translated back to Pyright's original ID
- [ ] Three-client concurrency test passes with overlapping requests (no cross-talk)
- [ ] Server-initiated-request routing test passes
- [ ] All existing tests pass: `cd packages/pyright-mcp && npx jest --forceExit`
- [ ] `cd packages/pyright-internal && npm run test:norebuild` — no regressions
- [ ] `npm run typecheck` clean

## Anti-Patterns

- **Don't keep the byte-tee and "just document the race."** That's what got us here. If the proxy's job is to be a proxy, it has to understand the protocol.
- **Don't shell out ID normalization to each client.** Clients shouldn't have to know they're sharing a backend. Random offsets, manual ID ranges, per-client counters — all leak the proxy's brokenness into every consumer.
- **Don't broadcast responses "because it's simpler."** Simpler than routing is wrong. Simple and correct is the bar.
- **Don't serialize client-to-Pyright writes by introducing a lock at the client level.** The proxy owns Pyright's stdin; the proxy serializes.

## Key Considerations

- **Blocks pyr-bay and pyr-tcv.** Task 2 (inlayHint) will add more overlapping requests on the same Pyright; the Phase 5.5 acceptance demo can't credibly run until multiplexing is correct.
- **LSP framing parser reuse:** `StreamMessageReader`/`StreamMessageWriter` from `vscode-jsonrpc/node` is already the framing primitive used everywhere else in the codebase. Use them on both sides of the bridge so we're not maintaining a custom parser.
- **Backpressure:** if Pyright's stdin write stalls (buffer full), clients can't just keep writing. A bounded async queue per client with a reasonable high-water mark keeps one slow responder from starving others.
- **Connection lifecycle:** when a client disconnects, any pending proxy IDs owned by that client must be cleaned up — and if Pyright later responds with one of those IDs, drop silently rather than routing to a dead socket.
- **Server-initiated primary client:** `workspace/configuration` gets sent once at initialize. If the LSP plugin initialized first, it's the natural primary. If only the hook and MCP are connected, someone still has to answer. Choice: first-connected client becomes primary until it disconnects, then fail-over to next. Document in the implementation.
- **Notification filtering:** some notifications are client-scoped even without IDs (e.g., `window/logMessage` is informational and broadcast is fine; `window/showMessage` asks for user display and probably should go to a single client). Start with "broadcast all notifications" and refine if a specific notification misbehaves.

## Log

(None yet.)
- [2026-04-19T01:37:57Z] [Seth] Filed after user surfaced decision-laundering: pyr-noe's checkpoint framed the broadcast-tee proxy design as a walking-skeleton trade-off, when it's actually a bug masquerading as documentation. Proxy parses no JSON-RPC, does no ID translation, broadcasts every Pyright stdout byte to every client. Pyright's MessageConnection correlates by locally-generated IDs, so two clients sending ID 1 in overlapping windows get cross-talked responses. Blocks pyr-bay (inlayHint) and pyr-tcv (Phase 5.5 acceptance) — Task 2 adds more concurrent requests and the acceptance demo can't credibly run on a broken multiplexer.
