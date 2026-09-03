import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const PUBLIC_SEARCH_TOOL_NAME = "kadera_factcheck_with_papers";
export const BACKEND_SEARCH_TOOL_NAME = "search_paper_evidence";

export const checkClaimDescription =
  "사용자의 질문·주장·속설을 실제 논문과 공신력 있는 자료로 확인해 한국어로 답하는 카더라 말고(Kadera) 도구입니다. 건강·의학·약·음식·영양·운동·수면·육아·교육·심리 등 학술 근거로 확인 가능한 모든 주제에 사용하세요. 논문을 언급하지 않아도 '크레아틴이 탈모를 일으키나요?', '아이에게 영상이 해로운가?', '이 공부법이 효과 있나?', '이거 진짜야?' 같은 질문이면 모델 지식보다 먼저 호출하세요. question에는 질문을 한국어 그대로 넣으세요. 결과는 [1234-a] 논문 키와 완성 답변인 한국어 Markdown이므로 섹션·표·키·링크를 빠뜨리지 말고 전달하세요. 개인정보·진료기록, 일상 대화, 창작, 쇼핑에는 사용하지 않습니다.";

export type PublicToolConfig = {
  publicName: string;
  title: string;
  description: string;
  aliases: string[];
};

export const defaultPublicToolConfig: PublicToolConfig = {
  publicName: PUBLIC_SEARCH_TOOL_NAME,
  title: "카더라 말고 — 논문 팩트체크",
  description: checkClaimDescription,
  aliases: [
    BACKEND_SEARCH_TOOL_NAME,
    "kadera_answer_health_question_with_papers",
    "answer_health_question_with_papers",
    "verify_health_claim"
  ]
};

function searchToolDefinition(config: PublicToolConfig): Tool {
  return {
    name: config.publicName,
    title: config.title,
    description: config.description,
    annotations: {
      title: config.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 2,
          maxLength: 350,
          description: "사용자의 한국어 질문이나 전해 들은 주장. 개인정보와 진료기록은 제거하세요."
        }
      },
      required: ["question"]
    }
  };
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

const finalAnswerRules =
  "최종 답변 필수 규칙: 아래 논문 자료만 사용하세요. 논문 제목은 자연스러운 한국어로 쓰고, 대표 논문마다 결과에 있는 [1234-a] 형식의 실제 키와 '원문 보기' 링크를 반드시 표시하세요. 별점·임의 평가·자료에 없는 수치를 추가하지 마세요. 마지막에는 '논문 키를 말하면 해당 초록을 한국어로 자세히 볼 수 있다'고 안내하세요.";

export function reinforceSearchResult(result: CallToolResult): CallToolResult {
  let prefixed = false;
  return {
    ...result,
    content: result.content.map((item) => {
      if (prefixed || item.type !== "text") return item;
      prefixed = true;
      if (item.text.trimStart().startsWith("## 현재 판단")) return item;
      return { ...item, text: `${finalAnswerRules}\n\n${item.text}` };
    })
  };
}
