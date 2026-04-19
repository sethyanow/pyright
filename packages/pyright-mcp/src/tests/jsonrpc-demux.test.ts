import { PassThrough, Readable, Writable } from 'stream';
import {
    StreamMessageReader,
    StreamMessageWriter,
    RequestMessage,
    ResponseMessage,
    NotificationMessage,
} from 'vscode-jsonrpc/node';
import { createServer, Socket, createConnection, Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { JsonRpcDemux } from '../jsonrpc-demux';

// Paired Pyright mock: demux writes to pyrightStdin, reads from pyrightStdout.
// Test writes to pyrightWriter (to send a "Pyright response"), reads from pyrightReader
// (to observe what the demux forwarded to Pyright's stdin).
interface PyrightMock {
    pyrightStdin: Writable;
    pyrightStdout: Readable;
    pyrightReader: StreamMessageReader;
    pyrightWriter: StreamMessageWriter;
    receivedByPyright: any[];
    cleanup: () => void;
}

function makePyrightMock(): PyrightMock {
    // demuxToPyright: demux writes (==> Pyright stdin); test reads via reader to see what arrived
    const demuxToPyright = new PassThrough();
    // pyrightToDemux: test writes (Pyright's output); demux reads via its internal reader
    const pyrightToDemux = new PassThrough();

    const pyrightReader = new StreamMessageReader(demuxToPyright);
    const pyrightWriter = new StreamMessageWriter(pyrightToDemux);

    const received: any[] = [];
    pyrightReader.listen((msg) => {
        received.push(msg);
    });

    return {
        pyrightStdin: demuxToPyright,
        pyrightStdout: pyrightToDemux,
        pyrightReader,
        pyrightWriter,
        receivedByPyright: received,
        cleanup: () => {
            demuxToPyright.destroy();
            pyrightToDemux.destroy();
        },
    };
}

interface ClientPair {
    clientSocket: Socket;  // "client-facing" end — what the demux receives
    userSocket: Socket;    // "user-facing" end — what the test writes/reads on
    server: Server;
    socketPath: string;
    clientWriter: StreamMessageWriter;
    clientReader: StreamMessageReader;
    receivedByClient: any[];
    cleanup: () => Promise<void>;
}

async function makeClientPair(dir: string, name: string): Promise<ClientPair> {
    const socketPath = path.join(dir, `${name}.sock`);
    return new Promise((resolve, reject) => {
        let clientSocket: Socket | undefined;
        const server = createServer((accepted) => {
            clientSocket = accepted;
            // Once both sides connected, resolve
            if (userSocket && userSocket.readyState === 'open') {
                finishSetup();
            }
        });
        server.on('error', reject);

        let userSocket: Socket | undefined;
        server.listen(socketPath, () => {
            userSocket = createConnection(socketPath);
            userSocket.on('connect', () => {
                if (clientSocket) finishSetup();
            });
            userSocket.on('error', reject);
        });

        function finishSetup() {
            const clientWriter = new StreamMessageWriter(userSocket!);
            const clientReader = new StreamMessageReader(userSocket!);
            const received: any[] = [];
            clientReader.listen((msg) => {
                received.push(msg);
            });
            resolve({
                clientSocket: clientSocket!,
                userSocket: userSocket!,
                server,
                socketPath,
                clientWriter,
                clientReader,
                receivedByClient: received,
                cleanup: () => new Promise<void>((res) => {
                    userSocket!.destroy();
                    clientSocket!.destroy();
                    server.close(() => res());
                }),
            });
        }
    });
}

describe('JsonRpcDemux — single client', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-test-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('forwards a request with a translated proxy ID and routes the response back with the original client ID', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const client = await makeClientPair(tmp, 'single-client-1');
        demux.addClient(client.clientSocket);

        // Client sends a request with its own local ID 42
        const req: RequestMessage = {
            jsonrpc: '2.0',
            id: 42,
            method: 'textDocument/hover',
            params: { textDocument: { uri: 'file:///x.py' }, position: { line: 0, character: 0 } },
        };
        await client.clientWriter.write(req);

        // Wait until Pyright sees the forwarded message
        await waitFor(() => pyright.receivedByPyright.length >= 1);

        const forwarded = pyright.receivedByPyright[0];
        expect(forwarded.method).toBe('textDocument/hover');
        expect(forwarded.id).toBeDefined();
        const proxyId = forwarded.id;
        // The proxy ID should NOT equal the client's original ID 42 — it's a new allocation
        expect(proxyId).not.toBe(42);

        // Pyright responds with the proxy ID
        const pyrightResponse: ResponseMessage = {
            jsonrpc: '2.0',
            id: proxyId,
            result: { contents: 'hover-text' },
        };
        await pyright.pyrightWriter.write(pyrightResponse);

        await waitFor(() => client.receivedByClient.length >= 1);

        expect(client.receivedByClient).toHaveLength(1);
        expect(client.receivedByClient[0].id).toBe(42); // Original client ID restored
        expect(client.receivedByClient[0].result).toEqual({ contents: 'hover-text' });

        demux.dispose();
        await client.cleanup();
        pyright.cleanup();
    }, 10_000);
});

describe('JsonRpcDemux — notifications', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-notif-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('client-to-server notification reaches Pyright with no ID translation (since there is no id)', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const client = await makeClientPair(tmp, 'notif-c2s');
        demux.addClient(client.clientSocket);

        const notif: NotificationMessage = {
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
                textDocument: { uri: 'file:///x.py', languageId: 'python', version: 1, text: 'pass' },
            },
        };
        await client.clientWriter.write(notif);

        await waitFor(() => pyright.receivedByPyright.length >= 1);

        expect(pyright.receivedByPyright).toHaveLength(1);
        expect(pyright.receivedByPyright[0].method).toBe('textDocument/didOpen');
        // No id on notifications
        expect(pyright.receivedByPyright[0].id).toBeUndefined();

        demux.dispose();
        await client.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('client-to-server notification is NOT broadcast to other connected clients', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'notif-c2s-A');
        const clientB = await makeClientPair(tmp, 'notif-c2s-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        const notif: NotificationMessage = {
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
                textDocument: { uri: 'file:///x.py', languageId: 'python', version: 1, text: 'pass' },
            },
        };
        await clientA.clientWriter.write(notif);

        await waitFor(() => pyright.receivedByPyright.length >= 1);
        // Give any erroneous broadcast time to propagate
        await new Promise((r) => setTimeout(r, 100));

        expect(pyright.receivedByPyright).toHaveLength(1);
        expect(clientA.receivedByClient).toHaveLength(0);
        expect(clientB.receivedByClient).toHaveLength(0);

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('server-to-client notification is broadcast to ALL connected clients', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'notif-s2c-A');
        const clientB = await makeClientPair(tmp, 'notif-s2c-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        const diag: NotificationMessage = {
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: { uri: 'file:///x.py', diagnostics: [] },
        };
        await pyright.pyrightWriter.write(diag);

        await waitFor(() => clientA.receivedByClient.length >= 1 && clientB.receivedByClient.length >= 1);

        expect(clientA.receivedByClient).toHaveLength(1);
        expect(clientB.receivedByClient).toHaveLength(1);
        expect(clientA.receivedByClient[0].method).toBe('textDocument/publishDiagnostics');
        expect(clientB.receivedByClient[0].method).toBe('textDocument/publishDiagnostics');

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);
});

describe('JsonRpcDemux — serialized writer (no interleaving)', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-interleave-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('two clients sending large concurrent messages — Pyright parses both intact (no Content-Length desync)', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'interleave-A');
        const clientB = await makeClientPair(tmp, 'interleave-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        // Each message ~32KB — exceeds the default 16KB pipe buffer
        const bigPayloadA = 'A'.repeat(32 * 1024);
        const bigPayloadB = 'B'.repeat(32 * 1024);

        const reqA: RequestMessage = {
            jsonrpc: '2.0', id: 1,
            method: 'textDocument/didOpen',
            params: { textDocument: { uri: 'file:///a.py', languageId: 'python', version: 1, text: bigPayloadA } },
        };
        const reqB: RequestMessage = {
            jsonrpc: '2.0', id: 1,
            method: 'textDocument/didOpen',
            params: { textDocument: { uri: 'file:///b.py', languageId: 'python', version: 1, text: bigPayloadB } },
        };

        // Fire concurrently (no await between)
        const writePromises = [
            clientA.clientWriter.write(reqA),
            clientB.clientWriter.write(reqB),
        ];
        await Promise.all(writePromises);

        await waitFor(() => pyright.receivedByPyright.length >= 2);

        expect(pyright.receivedByPyright).toHaveLength(2);
        const textA = pyright.receivedByPyright.find((m) => m.params?.textDocument?.uri === 'file:///a.py')!;
        const textB = pyright.receivedByPyright.find((m) => m.params?.textDocument?.uri === 'file:///b.py')!;
        expect(textA).toBeDefined();
        expect(textB).toBeDefined();
        // Payloads intact — no interleaving corrupted the JSON
        expect(textA.params.textDocument.text).toBe(bigPayloadA);
        expect(textB.params.textDocument.text).toBe(bigPayloadB);

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 15_000);
});

describe('JsonRpcDemux — server-initiated requests + primary election', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-server-req-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('routes a Pyright-initiated request to the primary (first-connected) client and translates the response back', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'srv-req-A');
        const clientB = await makeClientPair(tmp, 'srv-req-B');
        demux.addClient(clientA.clientSocket); // primary (first)
        demux.addClient(clientB.clientSocket);

        // Pyright sends a server-initiated request with its own ID 5
        const serverReq: RequestMessage = {
            jsonrpc: '2.0', id: 5,
            method: 'workspace/configuration',
            params: { items: [{ section: 'python' }] },
        };
        await pyright.pyrightWriter.write(serverReq);

        // Primary (A) should receive it; B should not
        await waitFor(() => clientA.receivedByClient.length >= 1);
        await new Promise((r) => setTimeout(r, 100)); // give erroneous routes time to arrive

        expect(clientA.receivedByClient).toHaveLength(1);
        expect(clientB.receivedByClient).toHaveLength(0);

        const arrived = clientA.receivedByClient[0];
        expect(arrived.method).toBe('workspace/configuration');
        expect(arrived.id).toBeDefined();
        // ID should be a proxy ID, not Pyright's 5
        expect(arrived.id).not.toBe(5);
        const proxyId = arrived.id;

        // clientA responds with the proxy ID
        const clientResponse: ResponseMessage = {
            jsonrpc: '2.0', id: proxyId,
            result: [{ python: { version: '3.11' } }],
        };
        await clientA.clientWriter.write(clientResponse);

        await waitFor(() => pyright.receivedByPyright.some((m) => m.id === 5 && 'result' in m));

        const pyrightResp = pyright.receivedByPyright.find((m) => m.id === 5 && 'result' in m)!;
        expect(pyrightResp).toBeDefined();
        expect(pyrightResp.id).toBe(5); // Pyright's original ID restored
        expect(pyrightResp.result).toEqual([{ python: { version: '3.11' } }]);

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);
});

describe('JsonRpcDemux — $/cancelRequest translation', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-cancel-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('client cancellation translates to proxy ID before reaching Pyright; other clients unaffected', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'cancel-A');
        const clientB = await makeClientPair(tmp, 'cancel-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        // Both clients send requests. A's local id = 42, B's local id = 99.
        await clientA.clientWriter.write({
            jsonrpc: '2.0', id: 42,
            method: 'textDocument/hover',
            params: { textDocument: { uri: 'file:///a.py' }, position: { line: 0, character: 0 } },
        } as RequestMessage);
        await clientB.clientWriter.write({
            jsonrpc: '2.0', id: 99,
            method: 'textDocument/hover',
            params: { textDocument: { uri: 'file:///b.py' }, position: { line: 0, character: 0 } },
        } as RequestMessage);

        await waitFor(() => pyright.receivedByPyright.length >= 2);

        const fwdA = pyright.receivedByPyright.find((m) => m.params?.textDocument?.uri === 'file:///a.py')!;
        const fwdB = pyright.receivedByPyright.find((m) => m.params?.textDocument?.uri === 'file:///b.py')!;
        const proxyIdA = fwdA.id;
        const proxyIdB = fwdB.id;

        // Client A cancels its request (with A's local id 42)
        const cancelNotif: NotificationMessage = {
            jsonrpc: '2.0',
            method: '$/cancelRequest',
            params: { id: 42 },
        };
        await clientA.clientWriter.write(cancelNotif);

        // Wait for cancel to propagate
        await waitFor(() => pyright.receivedByPyright.some((m) => m.method === '$/cancelRequest'));

        const cancelAtPyright = pyright.receivedByPyright.find((m) => m.method === '$/cancelRequest')!;
        expect(cancelAtPyright.params.id).toBe(proxyIdA); // Translated to proxy ID
        expect(cancelAtPyright.params.id).not.toBe(42); // Not the client's local ID
        expect(cancelAtPyright.params.id).not.toBe(proxyIdB); // Not the other client's

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('Pyright cancellation of a server-initiated request is translated to the primary\'s allocated proxy ID', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'cancel-rev-A');
        demux.addClient(clientA.clientSocket);

        // Pyright sends a server-initiated request, id 7
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: 7,
            method: 'workspace/configuration',
            params: { items: [] },
        } as RequestMessage);

        await waitFor(() => clientA.receivedByClient.length >= 1);
        const arrived = clientA.receivedByClient[0];
        const proxyId = arrived.id;
        expect(proxyId).not.toBe(7);

        // Pyright cancels its own request
        const pyrightCancel: NotificationMessage = {
            jsonrpc: '2.0',
            method: '$/cancelRequest',
            params: { id: 7 },
        };
        await pyright.pyrightWriter.write(pyrightCancel);

        await waitFor(() => clientA.receivedByClient.some((m) => m.method === '$/cancelRequest'));

        const cancelAtClient = clientA.receivedByClient.find((m) => m.method === '$/cancelRequest')!;
        expect(cancelAtClient.params.id).toBe(proxyId); // translated to the primary's proxy ID
        expect(cancelAtClient.params.id).not.toBe(7); // not Pyright's ID

        demux.dispose();
        await clientA.cleanup();
        pyright.cleanup();
    }, 10_000);
});

describe('JsonRpcDemux — initialize multiplexing', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-init-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('forwards the first client\'s initialize to Pyright and caches the result', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'init-1');
        demux.addClient(clientA.clientSocket);

        const initReq: RequestMessage = {
            jsonrpc: '2.0', id: 1,
            method: 'initialize',
            params: { processId: 1, rootUri: 'file:///x', capabilities: {} },
        };
        await clientA.clientWriter.write(initReq);

        await waitFor(() => pyright.receivedByPyright.length >= 1);
        const forwarded = pyright.receivedByPyright[0];
        expect(forwarded.method).toBe('initialize');

        // Pyright responds
        const initResult = { capabilities: { hoverProvider: true } };
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: forwarded.id,
            result: initResult,
        } as ResponseMessage);

        await waitFor(() => clientA.receivedByClient.length >= 1);
        expect(clientA.receivedByClient[0].id).toBe(1);
        expect(clientA.receivedByClient[0].result).toEqual(initResult);

        demux.dispose();
        await clientA.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('queues non-initialize messages from other clients while first client\'s initialize is IN_FLIGHT', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'init-2-A');
        const clientB = await makeClientPair(tmp, 'init-2-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        // Client A sends initialize
        await clientA.clientWriter.write({
            jsonrpc: '2.0', id: 1,
            method: 'initialize',
            params: { processId: 1, rootUri: 'file:///x', capabilities: {} },
        } as RequestMessage);

        // Client B sends a NON-initialize request before A's init completes
        await clientB.clientWriter.write({
            jsonrpc: '2.0', id: 1,
            method: 'textDocument/hover',
            params: { textDocument: { uri: 'file:///b.py' }, position: { line: 0, character: 0 } },
        } as RequestMessage);

        // Give a moment for any premature forwarding
        await new Promise((r) => setTimeout(r, 100));

        // Only initialize should have reached Pyright — B's hover is queued
        expect(pyright.receivedByPyright).toHaveLength(1);
        expect(pyright.receivedByPyright[0].method).toBe('initialize');

        // Pyright responds to initialize
        const initId = pyright.receivedByPyright[0].id;
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: initId,
            result: { capabilities: { hoverProvider: true } },
        } as ResponseMessage);

        // Now B's queued hover should be forwarded to Pyright
        await waitFor(() => pyright.receivedByPyright.length >= 2);
        const hover = pyright.receivedByPyright.find((m) => m.method === 'textDocument/hover');
        expect(hover).toBeDefined();

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('synthesizes cached initialize result for subsequent clients without forwarding to Pyright', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'init-3-A');
        demux.addClient(clientA.clientSocket);

        // A sends and gets initialize response
        await clientA.clientWriter.write({
            jsonrpc: '2.0', id: 1,
            method: 'initialize',
            params: { processId: 1, rootUri: 'file:///x', capabilities: {} },
        } as RequestMessage);
        await waitFor(() => pyright.receivedByPyright.length >= 1);
        const initId = pyright.receivedByPyright[0].id;
        const initResult = { capabilities: { hoverProvider: true, codeLensProvider: {} } };
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: initId,
            result: initResult,
        } as ResponseMessage);
        await waitFor(() => clientA.receivedByClient.length >= 1);

        // Snapshot Pyright's received count BEFORE client B sends initialize
        const pyrightCountBeforeB = pyright.receivedByPyright.length;

        // Client B connects AFTER A's initialize completed
        const clientB = await makeClientPair(tmp, 'init-3-B');
        demux.addClient(clientB.clientSocket);

        await clientB.clientWriter.write({
            jsonrpc: '2.0', id: 42,
            method: 'initialize',
            params: { processId: 2, rootUri: 'file:///x', capabilities: {} },
        } as RequestMessage);

        await waitFor(() => clientB.receivedByClient.length >= 1);

        // B gets the cached result with B's original ID
        expect(clientB.receivedByClient[0].id).toBe(42);
        expect(clientB.receivedByClient[0].result).toEqual(initResult);

        // Pyright should NOT have received B's initialize
        await new Promise((r) => setTimeout(r, 100));
        expect(pyright.receivedByPyright.length).toBe(pyrightCountBeforeB);

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);
});

describe('JsonRpcDemux — connection lifecycle cleanup', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-cleanup-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('late Pyright response for a disconnected client is dropped silently (no crash)', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'life-A');
        const clientB = await makeClientPair(tmp, 'life-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        await clientA.clientWriter.write({
            jsonrpc: '2.0', id: 1,
            method: 'workspace/symbol',
            params: { query: 'X' },
        } as RequestMessage);

        await waitFor(() => pyright.receivedByPyright.length >= 1);
        const proxyIdA = pyright.receivedByPyright[0].id;

        // Client A disconnects
        await clientA.cleanup();
        // Give the demux a moment to observe the disconnect
        await new Promise((r) => setTimeout(r, 50));

        // Late response from Pyright arrives for client A's proxy ID
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: proxyIdA,
            result: { symbols: ['X'] },
        } as ResponseMessage);

        // Client B should still be working — send it a request, expect response
        await clientB.clientWriter.write({
            jsonrpc: '2.0', id: 50,
            method: 'workspace/symbol',
            params: { query: 'Y' },
        } as RequestMessage);
        await waitFor(() => pyright.receivedByPyright.length >= 2);
        const proxyIdB = pyright.receivedByPyright.find((m) => m.params?.query === 'Y')!.id;
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: proxyIdB,
            result: { symbols: ['Y'] },
        } as ResponseMessage);

        await waitFor(() => clientB.receivedByClient.length >= 1);
        expect(clientB.receivedByClient[0].id).toBe(50);
        expect(clientB.receivedByClient[0].result.symbols).toEqual(['Y']);

        demux.dispose();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('primary disconnect with an in-flight server-initiated request sends RequestCancelled back to Pyright', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'life-primary-A');
        const clientB = await makeClientPair(tmp, 'life-primary-B');
        demux.addClient(clientA.clientSocket); // primary
        demux.addClient(clientB.clientSocket);

        // Pyright sends a server-initiated request (primary, A, should receive)
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: 10,
            method: 'workspace/configuration',
            params: { items: [] },
        } as RequestMessage);
        await waitFor(() => clientA.receivedByClient.length >= 1);
        expect(clientA.receivedByClient[0].method).toBe('workspace/configuration');

        // Primary (A) disconnects BEFORE responding
        await clientA.cleanup();
        await new Promise((r) => setTimeout(r, 100));

        // Pyright should receive a RequestCancelled error response for ID 10
        await waitFor(() =>
            pyright.receivedByPyright.some(
                (m) => m.id === 10 && 'error' in m && (m as any).error.code === -32800
            )
        );
        const errResp = pyright.receivedByPyright.find(
            (m) => m.id === 10 && 'error' in m
        )! as any;
        expect(errResp.error.code).toBe(-32800); // RequestCancelled

        // New primary should be B — server-initiated request now routes there
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: 11,
            method: 'workspace/configuration',
            params: { items: [{ section: 'python' }] },
        } as RequestMessage);
        await waitFor(() => clientB.receivedByClient.length >= 1);
        expect(clientB.receivedByClient[0].method).toBe('workspace/configuration');

        demux.dispose();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);
});

describe('JsonRpcDemux — Pyright crash teardown', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-crash-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('Pyright stdout close synthesizes error responses for every pending request and invokes onPyrightExit', async () => {
        const pyright = makePyrightMock();
        let exitCalled = false;
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
            onPyrightExit: () => {
                exitCalled = true;
            },
        });

        const clientA = await makeClientPair(tmp, 'crash-A');
        const clientB = await makeClientPair(tmp, 'crash-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        // Each client has an in-flight request
        await clientA.clientWriter.write({
            jsonrpc: '2.0', id: 100,
            method: 'workspace/symbol',
            params: { query: 'AA' },
        } as RequestMessage);
        await clientB.clientWriter.write({
            jsonrpc: '2.0', id: 200,
            method: 'workspace/symbol',
            params: { query: 'BB' },
        } as RequestMessage);

        await waitFor(() => pyright.receivedByPyright.length >= 2);

        // Simulate Pyright crash by ending the stdout stream
        pyright.pyrightStdout.destroy();

        // Both clients should receive error responses with code -32097 (InternalError)
        await waitFor(() => clientA.receivedByClient.length >= 1 && clientB.receivedByClient.length >= 1);

        const respA = clientA.receivedByClient.find((m) => m.id === 100) as any;
        const respB = clientB.receivedByClient.find((m) => m.id === 200) as any;
        expect(respA).toBeDefined();
        expect(respB).toBeDefined();
        expect(respA.error.code).toBe(-32097);
        expect(respB.error.code).toBe(-32097);

        // onPyrightExit should have fired
        await waitFor(() => exitCalled);
        expect(exitCalled).toBe(true);

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);
});

describe('JsonRpcDemux — safety checks', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-safety-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('client reusing an in-flight ID gets InvalidRequest error; original request unaffected', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const client = await makeClientPair(tmp, 'safety-dup');
        demux.addClient(client.clientSocket);

        // Initialize handshake so state is COMPLETE
        await client.clientWriter.write({
            jsonrpc: '2.0', id: 0,
            method: 'initialize',
            params: {},
        } as RequestMessage);
        await waitFor(() => pyright.receivedByPyright.length >= 1);
        const initProxyId = pyright.receivedByPyright[0].id;
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: initProxyId,
            result: { capabilities: {} },
        } as ResponseMessage);
        await waitFor(() => client.receivedByClient.length >= 1);

        // First request with id 1 — valid
        await client.clientWriter.write({
            jsonrpc: '2.0', id: 1,
            method: 'workspace/symbol',
            params: { query: 'A' },
        } as RequestMessage);

        await waitFor(() => pyright.receivedByPyright.length >= 2);
        const pyrightCountAfterFirst = pyright.receivedByPyright.length;

        // Duplicate id 1 — should be rejected with error
        await client.clientWriter.write({
            jsonrpc: '2.0', id: 1,
            method: 'workspace/symbol',
            params: { query: 'B' },
        } as RequestMessage);

        await waitFor(() => client.receivedByClient.length >= 2); // init + error response

        const dupErr = client.receivedByClient.find(
            (m) => m.id === 1 && 'error' in m
        ) as any;
        expect(dupErr).toBeDefined();
        expect(dupErr.error.code).toBe(-32600); // InvalidRequest

        // Pyright should NOT have received the duplicate
        expect(pyright.receivedByPyright.length).toBe(pyrightCountAfterFirst);

        demux.dispose();
        await client.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('client exceeding MAX_IN_FLIGHT_PER_CLIENT gets ServerError; other clients unaffected', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const flooder = await makeClientPair(tmp, 'safety-flood');
        const victim = await makeClientPair(tmp, 'safety-victim');
        demux.addClient(flooder.clientSocket);
        demux.addClient(victim.clientSocket);

        // Initialize (first client)
        await flooder.clientWriter.write({
            jsonrpc: '2.0', id: 0,
            method: 'initialize',
            params: {},
        } as RequestMessage);
        await waitFor(() => pyright.receivedByPyright.length >= 1);
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: pyright.receivedByPyright[0].id,
            result: { capabilities: {} },
        } as ResponseMessage);
        await waitFor(() => flooder.receivedByClient.length >= 1);

        const pyrightCountAfterInit = pyright.receivedByPyright.length;

        // Flood: 1025 in-flight requests from one client. No responses sent, so they stay in-flight.
        const CAP = 1024;
        for (let i = 1; i <= CAP + 1; i++) {
            await flooder.clientWriter.write({
                jsonrpc: '2.0', id: i,
                method: 'workspace/symbol',
                params: { query: `q${i}` },
            } as RequestMessage);
        }

        // Wait for Pyright to have received CAP + init
        await waitFor(
            () => pyright.receivedByPyright.length >= pyrightCountAfterInit + CAP,
            5000
        );

        // Count error responses for the flooder
        await waitFor(
            () => flooder.receivedByClient.some((m) => 'error' in m && (m as any).error.code === -32001),
            3000
        );
        const capErrors = flooder.receivedByClient.filter(
            (m) => 'error' in m && (m as any).error.code === -32001
        );
        expect(capErrors.length).toBeGreaterThan(0);
        expect(pyright.receivedByPyright.length).toBe(pyrightCountAfterInit + CAP); // not CAP+1

        // Victim client still works
        await victim.clientWriter.write({
            jsonrpc: '2.0', id: 77,
            method: 'workspace/symbol',
            params: { query: 'victim' },
        } as RequestMessage);
        const victimForward = await waitForMatch(
            pyright.receivedByPyright,
            (m) => m.params?.query === 'victim'
        );
        expect(victimForward).toBeDefined();

        demux.dispose();
        await flooder.cleanup();
        await victim.cleanup();
        pyright.cleanup();
    }, 20_000);
});

describe('JsonRpcDemux — adversarial', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-adversarial-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('server-initiated request with no connected clients is dropped (no crash)', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        // No addClient calls — demux has no primary.
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: 7,
            method: 'workspace/configuration',
            params: { items: [] },
        } as RequestMessage);

        // Give it time to process (and crash, if it's going to)
        await new Promise((r) => setTimeout(r, 100));

        // Just verify the test reaches this line — demux didn't crash.
        expect(true).toBe(true);

        demux.dispose();
        pyright.cleanup();
    }, 5000);

    it('initialize failure synthesizes errors to queued clients and does not leak further messages to Pyright', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'adv-init-fail-A');
        const clientB = await makeClientPair(tmp, 'adv-init-fail-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        // A sends initialize
        await clientA.clientWriter.write({
            jsonrpc: '2.0', id: 1,
            method: 'initialize',
            params: {},
        } as RequestMessage);

        // B sends a request while init is IN_FLIGHT — gets queued
        await clientB.clientWriter.write({
            jsonrpc: '2.0', id: 99,
            method: 'workspace/symbol',
            params: { query: 'X' },
        } as RequestMessage);

        await waitFor(() => pyright.receivedByPyright.length >= 1);
        const initProxyId = pyright.receivedByPyright[0].id;

        // Pyright responds to initialize with an ERROR
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: initProxyId,
            error: { code: -32603, message: 'InitializeError' },
        } as ResponseMessage);

        // Client A should receive the initialize error
        await waitFor(() => clientA.receivedByClient.some((m) => 'error' in m));
        const aErr = clientA.receivedByClient.find((m) => 'error' in m) as any;
        expect(aErr.id).toBe(1);
        expect(aErr.error.code).toBe(-32603);

        // Client B's queued request should NOT leak to Pyright — init failed.
        // Give it a moment in case a misbehaving drain dispatches it anyway.
        await new Promise((r) => setTimeout(r, 100));
        const leakedToB = pyright.receivedByPyright.find((m) => m.params?.query === 'X');
        expect(leakedToB).toBeUndefined();

        // Client B should receive an error response (or the bridge should tear down).
        // Either is acceptable per the skeleton; minimal requirement is no silent hang.
        const bGotSomething =
            clientB.receivedByClient.length > 0 ||
            clientB.userSocket.destroyed ||
            clientB.userSocket.readyState === 'readOnly' ||
            clientB.userSocket.readyState === 'closed';
        expect(bGotSomething).toBe(true);

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);

    it('$/cancelRequest with missing or malformed params.id is dropped silently', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const client = await makeClientPair(tmp, 'adv-cancel-malformed');
        demux.addClient(client.clientSocket);

        // Send $/cancelRequest with no id
        await client.clientWriter.write({
            jsonrpc: '2.0',
            method: '$/cancelRequest',
            params: {},
        } as NotificationMessage);

        // Send $/cancelRequest with no params
        await client.clientWriter.write({
            jsonrpc: '2.0',
            method: '$/cancelRequest',
        } as NotificationMessage);

        await new Promise((r) => setTimeout(r, 100));

        // Neither should have reached Pyright.
        const cancels = pyright.receivedByPyright.filter((m) => m.method === '$/cancelRequest');
        expect(cancels).toHaveLength(0);

        demux.dispose();
        await client.cleanup();
        pyright.cleanup();
    }, 5000);

    it('string IDs (not just numeric) are preserved on the round trip', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const client = await makeClientPair(tmp, 'adv-stringid');
        demux.addClient(client.clientSocket);

        const req: RequestMessage = {
            jsonrpc: '2.0',
            id: 'abc-xyz-123', // string ID, spec-legal
            method: 'textDocument/hover',
            params: {},
        };
        await client.clientWriter.write(req);

        await waitFor(() => pyright.receivedByPyright.length >= 1);
        const fwd = pyright.receivedByPyright[0];
        // Proxy ID is numeric; original client ID was a string
        expect(typeof fwd.id).toBe('number');

        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: fwd.id,
            result: { contents: 'h' },
        } as ResponseMessage);

        await waitFor(() => client.receivedByClient.length >= 1);
        expect(client.receivedByClient[0].id).toBe('abc-xyz-123'); // string restored exactly

        demux.dispose();
        await client.cleanup();
        pyright.cleanup();
    }, 5000);

    it('ID = 0 is preserved (not confused with falsy "no ID")', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const client = await makeClientPair(tmp, 'adv-id-zero');
        demux.addClient(client.clientSocket);

        const req: RequestMessage = {
            jsonrpc: '2.0', id: 0,
            method: 'textDocument/hover',
            params: {},
        };
        await client.clientWriter.write(req);

        await waitFor(() => pyright.receivedByPyright.length >= 1);
        const fwd = pyright.receivedByPyright[0];

        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: fwd.id,
            result: { contents: 'h' },
        } as ResponseMessage);

        await waitFor(() => client.receivedByClient.length >= 1);
        expect(client.receivedByClient[0].id).toBe(0); // zero preserved

        demux.dispose();
        await client.cleanup();
        pyright.cleanup();
    }, 5000);

    it('addClient after dispose is safely ignored', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        demux.dispose();

        const client = await makeClientPair(tmp, 'adv-post-dispose');
        // addClient after dispose — should be a no-op or at least not crash
        expect(() => demux.addClient(client.clientSocket)).not.toThrow();
        // dispose() again should also be a no-op
        expect(() => demux.dispose()).not.toThrow();

        await client.cleanup();
        pyright.cleanup();
    }, 5000);

    it('client response for unknown proxy ID is dropped silently', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const client = await makeClientPair(tmp, 'adv-bogus-resp');
        demux.addClient(client.clientSocket);

        // Client fabricates a response to a request that was never server-initiated
        await client.clientWriter.write({
            jsonrpc: '2.0', id: 99999,
            result: { fake: true },
        } as ResponseMessage);

        await new Promise((r) => setTimeout(r, 100));

        // Nothing reached Pyright (no reverse-map entry)
        expect(pyright.receivedByPyright).toHaveLength(0);

        demux.dispose();
        await client.cleanup();
        pyright.cleanup();
    }, 5000);
});

describe('JsonRpcDemux — two-client ID isolation (core bug)', () => {
    let tmp: string;
    beforeAll(() => {
        tmp = mkdtempSync(path.join(tmpdir(), 'jsonrpc-demux-isolation-'));
    });
    afterAll(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('two clients sending the same local ID 1 each receive their own response — no cross-talk', async () => {
        const pyright = makePyrightMock();
        const demux = new JsonRpcDemux({
            pyrightStdin: pyright.pyrightStdin,
            pyrightStdout: pyright.pyrightStdout,
        });

        const clientA = await makeClientPair(tmp, 'iso-A');
        const clientB = await makeClientPair(tmp, 'iso-B');
        demux.addClient(clientA.clientSocket);
        demux.addClient(clientB.clientSocket);

        // Both clients pick the same local ID 1 — the bug scenario
        const reqA: RequestMessage = {
            jsonrpc: '2.0', id: 1,
            method: 'workspace/symbol',
            params: { query: 'ALPHA' },
        };
        const reqB: RequestMessage = {
            jsonrpc: '2.0', id: 1,
            method: 'workspace/symbol',
            params: { query: 'BETA' },
        };
        await clientA.clientWriter.write(reqA);
        await clientB.clientWriter.write(reqB);

        // Wait until Pyright has received both
        await waitFor(() => pyright.receivedByPyright.length >= 2);

        // Assert forwarded messages have DIFFERENT proxy IDs (no collision)
        const fwdA = pyright.receivedByPyright.find((m) => m.params?.query === 'ALPHA')!;
        const fwdB = pyright.receivedByPyright.find((m) => m.params?.query === 'BETA')!;
        expect(fwdA.id).not.toBe(fwdB.id);
        expect(fwdA.id).toBeDefined();
        expect(fwdB.id).toBeDefined();

        // Pyright responds to each proxy ID (in reverse order, deliberately, to catch any
        // ordering-dependent bug)
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: fwdB.id,
            result: { query: 'BETA', symbols: ['BetaClass'] },
        } as ResponseMessage);
        await pyright.pyrightWriter.write({
            jsonrpc: '2.0', id: fwdA.id,
            result: { query: 'ALPHA', symbols: ['AlphaClass'] },
        } as ResponseMessage);

        await waitFor(() => clientA.receivedByClient.length >= 1 && clientB.receivedByClient.length >= 1);

        // Each client receives its OWN response
        expect(clientA.receivedByClient).toHaveLength(1);
        expect(clientB.receivedByClient).toHaveLength(1);
        expect(clientA.receivedByClient[0].id).toBe(1); // client's original ID
        expect(clientA.receivedByClient[0].result.query).toBe('ALPHA');
        expect(clientB.receivedByClient[0].id).toBe(1); // client's original ID
        expect(clientB.receivedByClient[0].result.query).toBe('BETA');

        demux.dispose();
        await clientA.cleanup();
        await clientB.cleanup();
        pyright.cleanup();
    }, 10_000);
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function waitForMatch<T>(arr: T[], pred: (v: T) => boolean, timeoutMs = 2000): Promise<T | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const match = arr.find(pred);
        if (match) return match;
        await new Promise((r) => setTimeout(r, 10));
    }
    return undefined;
}
