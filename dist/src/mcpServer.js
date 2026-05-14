const SERVER_INFO = {
    name: "feishu-agent-bridge",
    version: "0.1.0"
};
export class MCPServer {
    registry;
    buffer = Buffer.alloc(0);
    outputMode = "content-length";
    constructor(registry) {
        this.registry = registry;
    }
    start() {
        process.stdin.on("data", (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.processBuffer().catch((error) => {
                this.writeError(null, -32603, error instanceof Error ? error.message : String(error));
            });
        });
        process.stdin.on("end", () => {
            process.exit(0);
        });
        process.stdin.resume();
    }
    async processBuffer() {
        while (true) {
            if (this.buffer.length === 0)
                return;
            if (this.buffer[0] === 0x7b) {
                const lineEnd = this.buffer.indexOf("\n");
                if (lineEnd === -1)
                    return;
                const body = this.buffer.subarray(0, lineEnd).toString("utf8").trim();
                this.buffer = this.buffer.subarray(lineEnd + 1);
                if (body.length > 0) {
                    await this.handleFrame(body, "line");
                }
                continue;
            }
            const header = findHeader(this.buffer);
            if (!header)
                return;
            const headers = this.buffer.subarray(0, header.end).toString("utf8");
            const match = headers.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                this.buffer = this.buffer.subarray(header.end + header.separatorLength);
                this.writeError(null, -32600, "Missing Content-Length header");
                continue;
            }
            const length = Number(match[1]);
            const frameStart = header.end + header.separatorLength;
            const frameEnd = frameStart + length;
            if (this.buffer.length < frameEnd)
                return;
            const body = this.buffer.subarray(frameStart, frameEnd).toString("utf8");
            this.buffer = this.buffer.subarray(frameEnd);
            await this.handleFrame(body, "content-length");
        }
    }
    async handleFrame(body, mode) {
        this.outputMode = mode;
        let request;
        try {
            request = JSON.parse(body);
        }
        catch (error) {
            this.writeError(null, -32700, `Parse error: ${error.message}`);
            return;
        }
        if (request.id === undefined && request.method.startsWith("notifications/")) {
            return;
        }
        if (request.id === undefined) {
            return;
        }
        try {
            const result = await this.dispatch(request);
            this.writeResponse({
                jsonrpc: "2.0",
                id: request.id,
                result
            });
        }
        catch (error) {
            this.writeError(request.id, -32603, error instanceof Error ? error.message : String(error));
        }
    }
    async dispatch(request) {
        switch (request.method) {
            case "initialize":
                return {
                    protocolVersion: readProtocolVersion(request.params),
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: SERVER_INFO
                };
            case "ping":
                return {};
            case "tools/list":
                return {
                    tools: this.registry.listTools()
                };
            case "tools/call":
                return this.callTool(request.params);
            default:
                throw new Error(`Method not found: ${request.method}`);
        }
    }
    async callTool(params) {
        if (!params || typeof params.name !== "string") {
            return {
                isError: true,
                content: [{ type: "text", text: "tools/call requires params.name" }]
            };
        }
        return this.registry.callTool(params.name, params.arguments ?? {});
    }
    writeError(id, code, message) {
        this.writeResponse({
            jsonrpc: "2.0",
            id: id ?? null,
            error: {
                code,
                message
            }
        });
    }
    writeResponse(response) {
        const body = Buffer.from(JSON.stringify(response), "utf8");
        if (this.outputMode === "line") {
            process.stdout.write(`${body.toString("utf8")}\n`);
        }
        else {
            process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
            process.stdout.write(body);
        }
    }
}
function findHeader(buffer) {
    const crlfEnd = buffer.indexOf("\r\n\r\n");
    const lfEnd = buffer.indexOf("\n\n");
    if (crlfEnd === -1 && lfEnd === -1) {
        return undefined;
    }
    if (crlfEnd !== -1 && (lfEnd === -1 || crlfEnd < lfEnd)) {
        return { end: crlfEnd, separatorLength: 4 };
    }
    return { end: lfEnd, separatorLength: 2 };
}
function readProtocolVersion(params) {
    if (params && typeof params.protocolVersion === "string") {
        return params.protocolVersion;
    }
    return "2024-11-05";
}
