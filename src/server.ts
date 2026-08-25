import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as z from "zod/v4";

const port = Number(process.env.PORT ?? 3000);
const backendUrl = stripTrailingSlash(process.env.KADERA_BACKEND_URL ?? "https://kadera-malgo-production.up.railway.app");
const backendTimeoutMs = Number(process.env.BACKEND_TIMEOUT_MS ?? 60000);
const categories = ["auto", "health", "childcare", "education", "exercise", "nutrition", "psychology"] as const;

type Category = (typeof categories)[number];

const app = express();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

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

export const checkClaimDescription =
  "Kadera(카더라 말고) retrieves real scholarly papers for Korean questions about health, food, diet, supplements, medicine, exercise, sleep, parenting, child development, psychology and study methods. It searches PubMed, Europe PMC, OpenAlex, WHO and Korean KCI/RISS live and returns the papers with links; it does not answer from a model's memory. Call it for any of these forms, even without the words paper or research: a question ('마운자로 부작용 있나?', '계란 하루 두 개 괜찮아?'), a claim the user repeats ('소시지가 몸에 안 좋대', '크레아틴 먹으면 탈모 온다던데'), curiosity about a topic ('간헐적 단식에 대해 궁금해', '피톤치드 알려줘'), or a request to verify ('이거 진짜야?', '카더라 아니야?'). Treat a claim the user reports hearing, and a topic they say they are curious about, as a request to check it. Prefer calling this over answering from memory: the user wants papers with links. Do not call it for casual chat, creative writing, personal opinions, shopping, or personal or medical-record data.";

function createServer(): McpServer {
  const server = new McpServer({
    name: "kadera-kakao-proxy",
    version: "0.1.0"
  });

  server.registerTool(
    "search_paper_evidence",
    {
      title: "카더라 검증",
      // This text is the only thing ChatGPT reads when deciding whether to
      // call, and the previous version only described the service. With
      // nothing saying when to reach for it, "마운자로 부작용이 있나?" was
      // answered from the model's own knowledge and the tool never ran.
      description: checkClaimDescription,
      annotations: {
        title: "카더라 검증",
        readOnlyHint: true,
        destructiveHint: false,
        // The same question can return a different paper set: sources are
        // live and a call that misses the search deadline omits them.
        idempotentHint: false,
        openWorldHint: true
      },
      // Only the question is required. The previous schema demanded an English
      // scholarly query up front, and the model stopped calling: for a
      // question it believes it can answer, composing a search string first is
      // a cost it will not pay. Everything else is optional and improves the
      // result when supplied.
      inputSchema: {
        question: z.string().min(2).max(350).describe("The user's question or the claim they repeated, in Korean. Remove personal and medical-record details."),
        academic_query: z.string().min(3).max(450).optional().describe("Strongly recommended. One English scholarly search query for the claim. Example: 'tirzepatide adverse events systematic review'. Without it the tool asks you for one."),
        topic_terms: z.array(z.string().min(2).max(100)).min(1).max(4).optional().describe("English name of the exact item asked about, plus true synonyms. Example: ['tirzepatide']."),
        outcome_terms: z.array(z.string().min(2).max(100)).min(1).max(4).optional().describe("English name of the outcome asked about. Example: ['adverse events'].")
      }
    },
    async (input) => {
      // Answering the first call with a request rather than a refusal keeps
      // the tool cheap to reach for: the model calls with the question alone,
      // learns what to add, and the second call is the real search. The reply
      // costs nothing -- no backend round trip.
      if (typeof input.academic_query !== "string" || input.academic_query.trim().length < 3) {
        return {
          content: [{ type: "text", text: missingQueryNotice(String(input.question ?? "")) }],
          isError: false
        };
      }
      return forwardToBackendMcp(input);
    }
  );

  return server;
}

/**
 * Forwards to the backend's own MCP tool instead of its web answer endpoint.
 *
 * The web endpoint plans the search with OpenAI, queries four databases and
 * extracts findings with a second model call, which measured 18.8s end to end
 * against Kakao's requirement of 100ms average and a 3,000ms p99 -- the tool
 * appeared stuck on "Kakao Tools 확인 중...". The MCP tool skips the planning
 * round trip because the host supplies the scholarly query, bounds retrieval,
 * and reuses a previous retrieval for a repeated question. Same call measured
 * 2.2s.
 *
 * The backend's result is returned untouched: it already carries the Korean
 * grounding rules, the term glossary and the crisis redirects.
 */
/** Scholarly databases index English, so a Korean query retrieves nothing. */
function missingQueryNotice(question: string): string {
  return [
    "검색을 실행하지 않았습니다. 논문 데이터베이스는 영어만 색인하므로 academic_query가 필요합니다.",
    `이 질문(\"${question.slice(0, 60)}\")을 영어 학술 검색어로 바꿔 같은 도구를 한 번 더 호출하세요.`,
    "의약품은 상품명이 아니라 성분명을 쓰세요. 예: '마운자로' → 'tirzepatide adverse events systematic review'.",
    "topic_terms와 outcome_terms도 함께 주면 정확도가 올라갑니다.",
    "사용자에게 관련 연구가 없다고 답하지 마세요."
  ].join(" ");
}

async function forwardToBackendMcp(args: Record<string, unknown>): Promise<CallToolResult> {
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
        params: { name: "search_paper_evidence", arguments: args }
      }),
      signal: controller.signal
    });

    const body = await response.text();
    if (!response.ok) throw new Error(`Backend ${response.status}: ${body.slice(0, 300)}`);
    const result = readJsonRpcResult(body);
    if (!result) throw new Error("Backend returned no tool result");
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/** The backend answers over SSE, so the JSON-RPC envelope arrives on a data line. */
function readJsonRpcResult(body: string): CallToolResult | undefined {
  for (const line of body.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!payload.startsWith("{")) continue;
    const parsed = JSON.parse(payload) as { result?: CallToolResult; error?: { message?: string } };
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
