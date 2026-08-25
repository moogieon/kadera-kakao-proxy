import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as z from "zod/v4";

const port = Number(process.env.PORT ?? 3000);
const backendUrl = stripTrailingSlash(process.env.KADERA_BACKEND_URL ?? "https://kadera-malgo-production.up.railway.app");
const backendTimeoutMs = Number(process.env.BACKEND_TIMEOUT_MS ?? 60000);
const categories = ["auto", "health", "childcare", "education", "exercise", "nutrition", "psychology"] as const;

type Category = (typeof categories)[number];

interface ClaimAnswer {
  answer_ko?: string;
  verdict?: string;
  evidence_level?: string;
  citations?: Citation[];
  practical_checks?: PracticalCheck[];
  safety_note?: string;
  category?: string;
  query_terms?: string[];
}

interface Citation {
  title?: string;
  year?: number;
  venue?: string;
  source?: string;
  url?: string;
  institutions?: string[];
}

interface PracticalCheck {
  label?: string;
  what_to_try_ko?: string;
  what_to_watch_ko?: string;
}

const app = express();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(cors);
app.use(securityHeaders);
app.use(rateLimit);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: "kadera-kakao-proxy", backend: backendUrl });
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
  "Kadera(카더라 말고) checks Korean everyday health rumors against live scholarly papers from PubMed, Europe PMC, OpenAlex, WHO and Korean KCI/RISS. Call it whenever the user asks whether something is good, bad, safe, effective, or true about health, food, diet, supplements, medicine, exercise, sleep, parenting, child development, psychology, or study methods, even when the user never says paper, research, or evidence. Typical Korean triggers: '마운자로 부작용 있나?', '소시지 몸에 안 좋아?', '크레아틴 먹으면 탈모 와?', '달걀 하루 두 개 괜찮아?', '간헐적 단식 효과 있어?', '아기한테 영상 보여줘도 돼?', '명상하면 불안 줄어?', '이거 진짜야?', '카더라 아니야?'. Prefer calling it over answering from memory: the user wants verified papers with links, not recollection. Do not call it for casual chat, creative writing, personal opinions, shopping, or anything involving personal or medical-record data.";

function createServer(): McpServer {
  const server = new McpServer({
    name: "kadera-kakao-proxy",
    version: "0.1.0"
  });

  server.registerTool(
    "check_claim",
    {
      title: "카더라 검증",
      // This text is the only thing ChatGPT reads when deciding whether to
      // call the tool, and the previous version only described the service.
      // With no instruction to prefer it over recall, "마운자로 부작용이
      // 있나?" was answered from the model's own knowledge and the tool never
      // ran. Kakao caps this at 1,024 characters and warns that an over-long
      // description hurts every tool in the user's 도구함, so the budget goes
      // to the calling decision: what this is, the Korean utterances that
      // should trigger it, and what must not.
      description: checkClaimDescription,
      annotations: {
        title: "카더라 검증",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: {
        question: z.string().min(2).max(350).describe("The user's Korean question or claim, with personal, account and medical-record details removed."),
        category: z.enum(categories).optional().default("auto").describe("Topic area. Use auto when unsure."),
        audience: z.string().optional().default("general").describe("Reader. Leave as general."),
        limit: z.number().int().min(1).max(10).optional().default(5).describe("Papers to retrieve per source.")
      }
    },
    async (input) => {
      const answer = await callRailwayBackend(input);
      return {
        content: [{ type: "text", text: formatAnswerForText(answer) }],
        structuredContent: { ...answer }
      };
    }
  );

  return server;
}

async function callRailwayBackend(input: { question: string; category?: Category; audience?: string; limit?: number }): Promise<ClaimAnswer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), backendTimeoutMs);

  try {
    const response = await fetch(`${backendUrl}/api/check-claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        question: input.question,
        category: input.category ?? "auto",
        audience: input.audience ?? "general",
        limit: input.limit ?? 5
      }),
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Backend ${response.status}: ${text.slice(0, 300)}`);
    }

    return JSON.parse(text) as ClaimAnswer;
  } finally {
    clearTimeout(timeout);
  }
}

function formatAnswerForText(answer: ClaimAnswer): string {
  const citations = formatVisibleCitations(answer.citations ?? []);
  const practicalChecks = answer.practical_checks?.slice(0, 3).map((item, index) => {
    const label = item.label ?? `확인 ${index + 1}`;
    return `${index + 1}. ${label}: ${[item.what_to_try_ko, item.what_to_watch_ko].filter(Boolean).join(" ")}`;
  });

  return [
    answer.answer_ko ?? "카더라 백엔드에서 답변을 받지 못했습니다.",
    "",
    answer.verdict ? `판정: ${verdictLabel(answer.verdict)}` : "",
    answer.evidence_level ? `근거 수준: ${evidenceLevelLabel(answer.evidence_level)}` : "",
    ...(practicalChecks?.length ? ["", "바로 확인해볼 것:", ...practicalChecks] : []),
    "",
    "대표 출처:",
    citations,
    "",
    answer.safety_note ?? "건강·육아·의학 관련 답변은 진료나 전문가 상담을 대체하지 않습니다."
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatVisibleCitations(citations: Citation[]): string {
  if (citations.length === 0) return "검색된 대표 출처 없음";

  return citations
    .slice(0, 3)
    .map((citation, index) => {
      const year = citation.year ? `${citation.year}` : "연도 미상";
      const venue = citation.venue || sourceLabel(citation.source);
      const institution = citation.institutions?.[0] ? `, ${citation.institutions[0]}` : "";
      const meta = [year, venue ? `${venue}${institution}` : ""].filter(Boolean).join(", ");
      const title = truncate(citation.title ?? "제목 없음", 92);
      const url = citation.url ?? "출처 링크 없음";
      return `[${index + 1}] ${title} (${meta})\n${url}`;
    })
    .join("\n");
}

function verdictLabel(verdict: string): string {
  const labels: Record<string, string> = {
    supports: "대체로 맞음",
    opposes: "대체로 아님",
    mixed: "근거가 엇갈림",
    insufficient_evidence: "근거 부족"
  };
  return labels[verdict] ?? verdict;
}

function evidenceLevelLabel(level: string): string {
  const labels: Record<string, string> = {
    systematic_review: "체계적 문헌고찰/메타분석급",
    guideline: "공식 지침/권고",
    randomized_trial: "무작위/임상연구급",
    observational: "관찰연구급",
    preprint: "프리프린트",
    unknown: "분류 불명"
  };
  return labels[level] ?? level;
}

function sourceLabel(source?: string): string {
  const labels: Record<string, string> = {
    pubmed: "PubMed",
    semantic_scholar: "Semantic Scholar",
    openalex: "OpenAlex",
    europe_pmc: "Europe PMC",
    core: "CORE",
    cochrane_crossref: "Cochrane/Crossref",
    who_gho: "WHO GHO",
    cdc: "CDC",
    myhealthfinder: "MyHealthfinder",
    arxiv: "arXiv",
    biorxiv: "bioRxiv",
    medrxiv: "medRxiv",
    crossref: "Crossref",
    eric: "ERIC",
    psyarxiv: "PsyArXiv",
    kci: "KCI",
    riss: "RISS"
  };
  return source ? labels[source] ?? source : "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
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
