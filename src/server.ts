import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import {
  BACKEND_SEARCH_TOOL_NAME,
  defaultPublicToolConfig,
  backendToolName,
  parsePublicToolConfig,
  publicToolList,
  reinforceSearchResult,
  type PublicToolConfig
} from "./toolManifest.js";

const port = Number(process.env.PORT ?? 3000);
const backendUrl = stripTrailingSlash(process.env.KADERA_BACKEND_URL ?? "https://kadera-malgo-production.up.railway.app");
const backendTimeoutMs = Number(process.env.BACKEND_TIMEOUT_MS ?? 60000);
const app = express();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let backendToolsCache: { tools: Tool[]; expiresAt: number } | undefined;
let publicToolConfigCache = { config: defaultPublicToolConfig, expiresAt: 0 };
let publicToolConfigRefresh: Promise<void> | undefined;
const publicToolConfigUrl = process.env.PUBLIC_TOOL_CONFIG_URL
  ?? "https://raw.githubusercontent.com/moogieon/kadera-kakao-proxy/main/public-tool.json";

refreshPublicToolConfig();
setInterval(refreshPublicToolConfig, 60_000).unref();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(cors);
app.use(securityHeaders);
app.use(rateLimit);

/** Lets a rollout be confirmed by asking rather than by probing behaviour. */
const buildCommit = (process.env.GIT_COMMIT
  ?? process.env.SOURCE_COMMIT
  ?? process.env.RAILWAY_GIT_COMMIT_SHA
  ?? "unknown").slice(0, 12);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: "kadera-kakao-proxy", backend: backendUrl, commit: buildCommit });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(406).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Not Acceptable: Client must use POST with Accept: text/event-stream" },
    id: null
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  });
});

app.listen(port, () => {
  console.log(`kadera-kakao-proxy listening on http://localhost:${port}/mcp`);
});

function createServer(): Server {
  const server = new Server(
    { name: "kadera-kakao-proxy", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } }
  );

  // The backend owns the available implementations. Search is the deliberate
  // public override: its branded intent name helps Kakao select it, and the
  // question-only schema leaves scholarly query planning inside Kadera.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const publicToolConfig = loadPublicToolConfig();
    const backendTools = await listBackendTools();
    return { tools: publicToolList(backendTools, publicToolConfig) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const publicToolConfig = loadPublicToolConfig();
    const toolName = request.params.name;
    const upstreamToolName = backendToolName(toolName, publicToolConfig);
    const isSearchTool = upstreamToolName === BACKEND_SEARCH_TOOL_NAME;
    const input = (request.params.arguments ?? {}) as Record<string, unknown>;
    const availableTools = await listBackendTools();

    if (!availableTools.some((tool) => tool.name === upstreamToolName)) {
      return {
        content: [{ type: "text", text: `Unknown or unavailable tool: ${toolName}` }],
        isError: true
      };
    }

    const result = await forwardToBackendMcp(upstreamToolName, input);
    return isSearchTool ? reinforceSearchResult(result) : result;
  });

  return server;
}

function loadPublicToolConfig(): PublicToolConfig {
  if (publicToolConfigCache.expiresAt <= Date.now()) {
    refreshPublicToolConfig();
  }
  return publicToolConfigCache.config;
}

function refreshPublicToolConfig(): void {
  if (publicToolConfigRefresh) return;

  publicToolConfigRefresh = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const separator = publicToolConfigUrl.includes("?") ? "&" : "?";
    const cacheBust = Math.floor(Date.now() / 60_000);

    try {
      const response = await fetch(`${publicToolConfigUrl}${separator}v=${cacheBust}`, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Public tool config ${response.status}`);
      publicToolConfigCache = {
        config: parsePublicToolConfig(await response.json()),
        expiresAt: Date.now() + 60_000
      };
    } catch (error) {
      console.error(`Public tool config fallback: ${error instanceof Error ? error.message : String(error)}`);
      publicToolConfigCache.expiresAt = Date.now() + 15_000;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    publicToolConfigRefresh = undefined;
  });
}

/**
 * Forwards to the backend's own MCP tool instead of its web answer endpoint.
 *
 * The backend MCP now plans a compact scholarly query from the Korean question
 * when the host does not supply one, then caches both the working plan and the
 * retrieval. Legacy callers can still supply the old detailed arguments.
 *
 * The backend's result is returned untouched: it already carries the Korean
 * grounding rules, the term glossary and the crisis redirects.
 */
async function listBackendTools(): Promise<Tool[]> {
  if (backendToolsCache && backendToolsCache.expiresAt > Date.now()) {
    return backendToolsCache.tools;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(backendTimeoutMs, 10_000));

  try {
    const response = await fetch(`${backendUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Backend ${response.status}: ${body.slice(0, 300)}`);
    const result = readJsonRpcResult<{ tools: Tool[] }>(body);
    if (!result?.tools?.length) throw new Error("Backend returned no public tools");

    backendToolsCache = { tools: result.tools, expiresAt: Date.now() + 60_000 };
    return result.tools;
  } catch (error) {
    // A brief backend restart should not erase tools from Kakao's manifest.
    if (backendToolsCache?.tools.length) return backendToolsCache.tools;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardToBackendMcp(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), backendTimeoutMs);

  try {
    const response = await fetch(`${backendUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args }
      }),
      signal: controller.signal
    });

    const body = await response.text();
    if (!response.ok) throw new Error(`Backend ${response.status}: ${body.slice(0, 300)}`);
    const result = readJsonRpcResult<CallToolResult>(body);
    if (!result) throw new Error("Backend returned no tool result");
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/** The backend answers over SSE, so the JSON-RPC envelope arrives on a data line. */
function readJsonRpcResult<T>(body: string): T | undefined {
  for (const line of body.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!payload.startsWith("{")) continue;
    const parsed = JSON.parse(payload) as { result?: T; error?: { message?: string } };
    if (parsed.error) throw new Error(parsed.error.message ?? "Backend tool error");
    if (parsed.result) return parsed.result;
  }
  return undefined;
}

function cors(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  next();
}

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/**
 * Kakao Tools proxies every user through a small set of egress addresses, so a
 * per-IP budget throttles the whole product rather than any one caller: twelve
 * requests a minute was shared by everybody. Kakao additionally treats a
 * failing tool as a service to hide or remove, which makes a false 429 far
 * more costly than the load it prevents. Keep one shared bucket, sized as an
 * overload guard.
 */
function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const now = Date.now();
  const bucket = rateBuckets.get("shared");
  const windowMs = 60_000;
  const maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 600);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set("shared", { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many requests. Please retry later." });
    return;
  }

  next();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
