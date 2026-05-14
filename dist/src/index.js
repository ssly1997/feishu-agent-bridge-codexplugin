#!/usr/bin/env node
import { MCPServer } from "./mcpServer.js";
import { createToolRegistry } from "./tools.js";
const server = new MCPServer(createToolRegistry());
server.start();
