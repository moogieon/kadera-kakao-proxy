import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const PUBLIC_SEARCH_TOOL_NAME = "answer_question_with_research";
export const BACKEND_SEARCH_TOOL_NAME = "search_paper_evidence";

export const checkClaimDescription =
  "Kadera(카더라 말고) answers Korean health, medicine, drug, food, nutrition, supplement, exercise, sleep, parenting, child-development, psychology, education, and study questions using current scholarly evidence rather than general model knowledge. Use it for effects, benefits, risks, side effects, safety, comparisons, and everyday claims; it returns a concise Korean conclusion, paper citations and links, plus reusable paper IDs.";

export type PublicToolConfig = {
  publicName: string;
  title: string;
  description: string;
  aliases: string[];
};

export const defaultPublicToolConfig: PublicToolConfig = {
  publicName: PUBLIC_SEARCH_TOOL_NAME,
  title: "논문 근거로 질문 답하기",
  description: checkClaimDescription,
  aliases: [
    BACKEND_SEARCH_TOOL_NAME,
    "kadera_factcheck_with_papers",
    "kadera_answer_health_question_with_papers",
    "answer_health_question_with_papers",
    "verify_health_claim"
  ]
};

export function publicServerInstructions(
  config: PublicToolConfig = defaultPublicToolConfig
): string {
  return `Use ${config.publicName} when a Korean user wants an evidence-based answer about health, medicine, drugs, food, nutrition, supplements, exercise, sleep, parenting, child development, psychology, education, or study methods. It covers natural questions, comparisons, claims, effects, benefits, risks, side effects, and safety even when the user does not explicitly ask for papers. When the user asks about a Kadera paper ID such as 8903-a, call get_paper_detail.`;
}

function searchToolDefinition(config: PublicToolConfig): Tool {
  return {
    name: config.publicName,
    title: config.title,
    description: config.description,
    annotations: {
      title: config.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      type: "object",
      properties: {
        claim_or_topic: {
          type: "string",
          minLength: 2,
          maxLength: 350,
          description: "A concise Korean topic or factual claim needed for literature search. Include only the subject and outcome being checked; exclude names, contact details, account data, medical records, and unrelated conversation text."
        }
      },
      required: ["claim_or_topic"]
    }
  };
}

/**
 * Kakao Tools must not forward a user's whole prompt through a description-led
 * catch-all parameter. The public contract asks for a concise claim/topic;
 * this adapter keeps the backend API stable and accepts cached legacy clients.
 */
export function toBackendSearchArguments(
  input: Record<string, unknown>
): Record<string, unknown> {
  const claimOrTopic = typeof input.claim_or_topic === "string"
    ? input.claim_or_topic.trim()
    : undefined;
  const legacyQuestion = typeof input.question === "string"
    ? input.question.trim()
    : undefined;
  const question = claimOrTopic || legacyQuestion;
  const { claim_or_topic: _claimOrTopic, ...rest } = input;

  return question ? { ...rest, question } : rest;
}

export function parsePublicToolConfig(value: unknown): PublicToolConfig {
  if (!value || typeof value !== "object") throw new Error("Public tool config must be an object");
  const config = value as Record<string, unknown>;
  const publicName = typeof config.publicName === "string" ? config.publicName.trim() : "";
  const title = typeof config.title === "string" ? config.title.trim() : "";
  const description = typeof config.description === "string" ? config.description.trim() : "";
  const aliases = Array.isArray(config.aliases)
    ? config.aliases.filter((alias): alias is string => typeof alias === "string" && alias.length > 0)
    : [];

  if (!/^[a-z][a-z0-9_]{2,63}$/.test(publicName)) throw new Error("Invalid public tool name");
  if (!title || title.length > 80) throw new Error("Invalid public tool title");
  if (!description || Buffer.byteLength(description, "utf8") >= 1024) {
    throw new Error("Invalid public tool description");
  }
  if (aliases.length > 10 || aliases.some((alias) => !/^[a-z][a-z0-9_]{2,63}$/.test(alias))) {
    throw new Error("Invalid public tool aliases");
  }

  return { publicName, title, description, aliases: [...new Set(aliases)] };
}

export function publicToolList(
  backendTools: Tool[],
  config: PublicToolConfig = defaultPublicToolConfig
): Tool[] {
  return backendTools.map((tool) => {
    if (tool.name === BACKEND_SEARCH_TOOL_NAME) return searchToolDefinition(config);
    if (tool.name === "get_paper_detail") {
      return {
        ...tool,
        description: (tool.description ?? "").replaceAll(BACKEND_SEARCH_TOOL_NAME, config.publicName)
      };
    }
    return tool;
  });
}

export function backendToolName(
  publicName: string,
  config: PublicToolConfig = defaultPublicToolConfig
): string {
  return publicName === config.publicName || config.aliases.includes(publicName)
    ? BACKEND_SEARCH_TOOL_NAME
    : publicName;
}

export function reinforceSearchResult(result: CallToolResult): CallToolResult {
  // Kakao's integration guide asks tools to return a small, curated Markdown
  // result. The backend packet intentionally contains detailed host-writing
  // policy and also repeats every abstract in structuredContent; forwarding it
  // produced a 13 KB response that ChatGPT for Kakao treated as if the search
  // had not answered. Keep a completed answer as-is, otherwise turn the
  // structured evidence into one compact text payload and drop the duplicate.
  const firstText = result.content.find((item) => item.type === "text");
  const completedAnswer = firstText?.type === "text" && firstText.text.trimStart().startsWith("## 현재 판단")
    ? firstText.text
    : undefined;
  const compactEvidence = completedAnswer ? undefined : formatCompactEvidence(result.structuredContent);
  const text = completedAnswer ?? compactEvidence ?? (firstText?.type === "text" ? firstText.text : undefined);
  const { structuredContent: _duplicateEvidence, ...rest } = result;
  if (!text) return rest;
  return { ...rest, content: [{ type: "text", text }] };
}

type EvidencePayload = {
  status?: unknown;
  retrieved_paper_count?: unknown;
  usable_paper_count?: unknown;
  glossary?: unknown;
  papers?: unknown;
};

type EvidencePaper = {
  paper_id?: unknown;
  title?: unknown;
  year?: unknown;
  evidence_level?: unknown;
  evidence_scope?: unknown;
  abstract_result?: unknown;
  url?: unknown;
};

function formatCompactEvidence(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as EvidencePayload;
  if (payload.status !== "ok" || !Array.isArray(payload.papers)) return undefined;
  const papers = payload.papers
    .filter((paper): paper is EvidencePaper => Boolean(paper) && typeof paper === "object")
    .slice(0, 5);
  if (papers.length === 0) return undefined;

  const retrieved = finiteInteger(payload.retrieved_paper_count) ?? papers.length;
  const usable = finiteInteger(payload.usable_paper_count) ?? papers.length;
  const glossary = Array.isArray(payload.glossary)
    ? payload.glossary.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as { term?: unknown; asked_as?: unknown };
        return typeof item.term === "string" && typeof item.asked_as === "string"
          ? [`${item.term} = ${item.asked_as}`]
          : [];
      }).slice(0, 3)
    : [];
  const blocks = papers.map((paper) => {
    const id = safeText(paper.paper_id, 12) ?? "논문 키 없음";
    const title = safeText(paper.title, 180) ?? "제목 정보 없음";
    const year = finiteInteger(paper.year);
    const result = safeText(paper.abstract_result, 320) ?? "초록에서 결과 문장을 확인하지 못했습니다.";
    const url = safeHttpUrl(paper.url);
    const metadata = [year ? `${year}년` : undefined, evidenceLevelKo(paper.evidence_level), evidenceScopeKo(paper.evidence_scope)]
      .filter(Boolean)
      .join(" · ");
    return [
      `### [${id}] ${title}`,
      ...(metadata ? [`- ${metadata}`] : []),
      `- 초록 결과: ${result}`,
      ...(url ? [`- [원문 보기](${url})`] : [])
    ].join("\n");
  });
  const followUpId = safeText(papers[0]?.paper_id, 12);

  return [
    "## 카더라 논문 검색 완료",
    `검색에 성공했습니다. 초록이 있는 후보 ${retrieved}편 중 대표 논문 ${usable}편을 확인했습니다.`,
    ...(glossary.length > 0 ? [`용어 대응: ${glossary.join(" · ")}`] : []),
    "아래 초록 결과만 근거로 질문에 먼저 한 문장으로 답한 뒤, 핵심 수치와 한계를 자연스러운 한국어로 설명하세요. 관찰된 연관성을 인과관계로 바꾸거나 논문에 없는 사실을 추가하지 마세요.",
    ...blocks,
    ...(followUpId
      ? ["## 논문을 더 자세히 보고 싶다면", `“${followUpId} 논문 자세히 알려줘”라고 물으면 저장된 초록을 한국어로 자세히 확인할 수 있습니다.`]
      : [])
  ].join("\n\n");
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function evidenceLevelKo(value: unknown): string | undefined {
  if (value === "systematic_review") return "체계적 문헌고찰·메타분석";
  if (value === "clinical_study") return "임상·비교 연구";
  if (value === "observational_study") return "관찰연구";
  if (value === "official_guidance") return "공식 지침";
  return undefined;
}

function evidenceScopeKo(value: unknown): string | undefined {
  if (value === "direct") return "질문을 직접 다룬 근거";
  if (value === "parent") return "상위 주제 보완 근거";
  if (value === "topic_context") return "질문 대상 보완 근거";
  if (value === "outcome_context") return "질문 결과 보완 근거";
  if (value === "related") return "관련 참고 근거";
  return undefined;
}
