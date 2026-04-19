---
id: pyr-klq
title: Proxy bridge is byte-level tee, not JSON-RPC demux — request-ID collision on shared Pyright
status: active
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
R10. `$/cancelRequest` notifications carry a request ID. Translate between client-local IDs and proxy IDs in both directions so a cancellation from client A cancels client A's forwarded request in Pyright — and a cancellation from Pyright (for one of its server-initiated requests) reaches only the client that owns the original request.
R11. `initialize` is accepted by Pyright exactly once per process lifetime. The demux forwards the first client's `initialize` to Pyright and caches the `InitializeResult`. Subsequent `initialize` requests from other clients receive a synthesized response (the cached result, with the client's original ID) without ever reaching Pyright. The `initialized` notification from any client is forwarded on first occurrence, swallowed thereafter.
R12. New test: unit-level demux test — two mock client sockets and a mock Pyright socket, feed crafted JSON-RPC messages through the bridge, assert per-client request/response routing and notification fan-out without spawning real Pyright.
R13. New test: cancellation round-trip — client A starts a long-running request with a cancellation token, cancels it, assert that `$/cancelRequest` reaches Pyright with the translated proxy ID and that client B's concurrent request is unaffected.
R14. New test: client→server notification is NOT broadcast — one client sends `didOpen`, assert Pyright receives it exactly once and other connected clients do not receive the notification.

## Success Criteria

- [x] `createSocketBridge` replaced by a JSON-RPC-aware multiplexer in `proxy.ts`
- [x] Client→Pyright: request IDs translated; writes serialized onto Pyright's stdin via a single `StreamMessageWriter`
- [x] Pyright→Client: responses routed only to the originating client by proxy-ID lookup
- [x] Notifications still fan out correctly (diagnostics reach every connected client; `didOpen` from any client reaches Pyright)
- [x] Server-initiated requests routed to a designated client; their responses translated back to Pyright's original ID
- [x] Three-client concurrency test passes with overlapping requests (no cross-talk)
- [x] Server-initiated-request routing test passes
- [x] `$/cancelRequest` IDs translated in both directions; cancellation test passes
- [x] `initialize` multiplexing: first client's forwarded to Pyright, result cached; subsequent clients' `initialize` receives synthesized response without hitting Pyright
- [x] Unit-level demux test (no real Pyright) passes — verifies routing logic in isolation
- [x] Client→server notification NOT broadcast; test asserts only Pyright receives forwarded `didOpen`
- [x] Initialize state machine: client B's request sent during client A's IN_FLIGHT initialize is queued and only forwarded after A's initialize completes (test)
- [x] Pyright crash teardown: killing the Pyright child process closes all connected client sockets and synthesizes error responses for pending requests (test)
- [x] All existing tests pass: `cd packages/pyright-mcp && npx jest --forceExit`
- [x] `cd packages/pyright-internal && npm run test:norebuild` — no regressions
- [x] `npm run typecheck` clean

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
- **Two independent ID maps, not one.** `clientIdToProxyId` maps forward (client→Pyright) — keyed by `(clientSocket, clientOriginalId)`, value is the allocated proxy ID. `pyrightIdToClientId` maps reverse (Pyright→client, for server-initiated requests) — keyed by `pyrightOriginalId`, value is `(clientSocket, allocatedProxyId)`. The two maps use different counters and never share namespace; the forward counter is proxy-local and the reverse counter is Pyright-local.
- **ID types on the wire.** JSON-RPC IDs can be number, string, or null. vscode-jsonrpc's `MessageConnection` emits numeric IDs, but the demux's parser must handle incoming IDs of any type (preserve the original exactly when translating back). Use the raw parsed JSON value as the map key — don't coerce to number.
- **`$/cancelRequest` is a notification with an embedded ID.** Unlike other notifications, it references a prior request's ID — so even though it has no outer `id`, it still needs ID translation on its `params.id` field before forwarding.
- **`initialize` semantics.** Pyright returns an error on a second `initialize`. Without multiplexing, every client after the first sees a cryptic error. The current hook workaround (`try/catch` in `socket-lsp-client.ts:76-78`) exists because of this exact problem. After this task ships, the workaround should still work but becomes unnecessary for the normal path — leave it in place as defense-in-depth. `shutdown`/`exit` still flows through normally and still tears down Pyright (per pyr-tcv R2: "any disconnect tears down Pyright").
- **Serialization preserves per-client ordering.** A single async mutex/channel over Pyright's stdin means messages write in arrival order across ALL clients. For a single client, this implicitly preserves its own send order because Node's socket data callbacks fire serially for that client. No per-client queue needed.

### Failure Catalog

**Initialize state machine (`NOT_SENT | IN_FLIGHT | COMPLETE`).**
- Assumption: client A's `initialize` completes before anyone else sends anything.
- Betrayal: client B connects while A's `initialize` is IN_FLIGHT and sends a request (or another `initialize`).
- Consequence: B's request reaches Pyright pre-initialize → Pyright errors. Or B's `initialize` reaches Pyright as a second init → "already initialized" error.
- Mitigation: While IN_FLIGHT, queue all client messages (not just initializes). On COMPLETE, drain in arrival order — synthesize cached `InitializeResult` for queued initializes; forward everything else. On initialize failure, synthesize the error back to every queued client and tear down the bridge.

**Pyright crash mid-session.**
- Assumption: Pyright's stdin stays writable for the bridge's lifetime.
- Betrayal: Pyright exits; next forward-write throws EPIPE; stdout reader emits `close`.
- Consequence: In-flight client requests hang forever; clients see silent timeouts.
- Mitigation: Wire Pyright's `close`/`exit` → bridge teardown. Teardown synthesizes JSON-RPC errors (`code: -32097 InternalError`) for every pending proxy ID, writes them to each owning client socket, then closes all client sockets. Symmetric to epic R2 (client disconnect tears down Pyright).

**Primary client disconnect with in-flight server-initiated request.**
- Assumption: Elected primary stays alive until Pyright's server-initiated requests resolve.
- Betrayal: Primary disconnects while `workspace/configuration` is outstanding.
- Consequence: Pyright hangs waiting for a response.
- Mitigation: On primary disconnect, synthesize a JSON-RPC error (`code: -32800 RequestCancelled`) for every reverse-map entry owned by that primary, write to Pyright via the serialized writer, then promote a new primary.

**Forward writer interleaving.**
- Assumption: `writer.write(msg)` is atomic on Pyright's stdin.
- Betrayal: Two handlers invoke write concurrently; Node backpressure splits large messages.
- Consequence: Content-Length framing desyncs — unrecoverable for the rest of the session.
- Mitigation: Async mutex over the writer. Every forward goes through `await queue.add(() => writer.write(msg))`. Await each write's returned Promise before starting the next.

**Unknown ID in Pyright response.**
- Assumption: Response IDs always resolve in the forward map.
- Betrayal: Client disconnected → cleanup removed entry → late response arrives.
- Consequence: Undefined lookup crashes router.
- Mitigation: Router checks map before dereferencing; unknown → drop silently (debug log only).

**Socket-write race on disconnected client.**
- Assumption: If a socket is in the map, it's writable.
- Betrayal: Socket closed between map lookup and `socket.write()`.
- Consequence: EPIPE on destroyed socket.
- Mitigation: Check `socket.destroyed` before write; wrap the write itself in try/catch for the tiny remaining race.

**Cleanup cost on disconnect.**
- Assumption: Cleanup on disconnect is cheap.
- Betrayal: Client with 1000+ pending requests disconnects; cleanup iterates the entire forward map.
- Consequence: CPU spike delays other clients' in-flight work.
- Mitigation: Maintain `clientToProxyIds: Map<Socket, Set<ProxyId>>` alongside the forward map. Disconnect cleanup is O(pending_for_that_client).

**Duplicate client ID.**
- Assumption: Each client uses unique IDs for its in-flight requests.
- Betrayal: Buggy client reuses an ID before the first response arrives.
- Consequence: Forward map overwrite — the first request's response routes to the wrong handler in the client.
- Mitigation: On insert, check `(socket, clientOriginalId)` collision. If present, synthesize an error response to the client (`code: -32600 InvalidRequest`) and don't forward.

**Unbounded in-flight requests per client.**
- Assumption: Clients send reasonable request volumes.
- Betrayal: A runaway client floods the proxy.
- Consequence: Memory growth; Pyright's stdin backpressure eventually stalls the serialized queue, starving all clients.
- Mitigation: Hard cap per client (constant `MAX_IN_FLIGHT_PER_CLIENT = 1024` at the top of the file). Over cap → synthesize error response (`-32001 ServerError`), don't forward.

## Log

(None yet.)
- [2026-04-19T01:37:57Z] [Seth] Filed after user surfaced decision-laundering: pyr-noe's checkpoint framed the broadcast-tee proxy design as a walking-skeleton trade-off, when it's actually a bug masquerading as documentation. Proxy parses no JSON-RPC, does no ID translation, broadcasts every Pyright stdout byte to every client. Pyright's MessageConnection correlates by locally-generated IDs, so two clients sending ID 1 in overlapping windows get cross-talked responses. Blocks pyr-bay (inlayHint) and pyr-tcv (Phase 5.5 acceptance) — Task 2 adds more concurrent requests and the acceptance demo can't credibly run on a broken multiplexer.
- [2026-04-19T02:07:24Z] [Seth] SRE: Verified all skeleton claims against code (createSocketBridge tee at proxy.ts:88-125, StreamMessageReader pattern at :288-331, vscode-jsonrpc sequenceNumber=0 at connection.js:297, three concurrent clients confirmed). Gaps filled additively: R10 $/cancelRequest translation, R11 initialize multiplexing with cached InitializeResult, R12 unit-level demux test promoted from narrative, R13 cancellation round-trip test, R14 client-to-server notification not broadcast test. Added Key Considerations for two independent ID maps, wire-type preservation, cancelRequest as notification-with-embedded-ID, initialize/shutdown semantics, and ordering via single serialization.
- [2026-04-19T02:10:31Z] [Seth] Adversarial planning: Added failure catalog (9 entries) and 2 new success criteria. Key findings: initialize state machine must queue ALL messages during IN_FLIGHT (not just subsequent initializes); Pyright crash must synthesize error responses to every pending client request and close client sockets; primary-disconnect must notify Pyright with RequestCancelled for every in-flight server-initiated request; per-client Set<ProxyId> needed for O(pending-for-client) cleanup vs O(total) iteration; MAX_IN_FLIGHT_PER_CLIENT=1024 cap prevents runaway client from starving others.
- [2026-04-19T02:56:41Z] [Seth] Adversarial stress test: 7 structural patterns applied (empty primary, initialize failure, malformed cancelRequest, string IDs, ID=0, addClient-after-dispose, unknown-proxy-ID response). 6 GREEN on first run, 1 RED fixed: initialize failure now synthesizes error responses to queued clients and calls onPyrightExit to signal teardown. Defense-in-depth: added _disposed guards to addClient, _onClientMessage, _onPyrightMessage. Final: pyright-mcp 72 tests pass (17 demux + 7 adversarial + 48 pre-existing), pyright-internal 2392 tests no regressions, typecheck clean.
