import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const PUBLIC_SEARCH_TOOL_NAME = "kadera_answer_health_question_with_papers";
export const BACKEND_SEARCH_TOOL_NAME = "search_paper_evidence";
const LEGACY_PUBLIC_SEARCH_TOOL_NAMES = new Set([
  "kadera_factcheck_with_papers",
  "answer_health_question_with_papers",
  "verify_health_claim",
  BACKEND_SEARCH_TOOL_NAME
]);

export const checkClaimDescription =
  "건강·의학·약·음식·영양·운동·수면·육아·심리 질문에 실제 논문으로 답하는 카더라 말고(Kadera) 도구입니다. '크레아틴이 탈모를 일으키나요?', '마운자로 부작용은?', '간헐적 단식 효과 있어?', '계란 하루 두 개 괜찮아?'처럼 사용자가 논문을 언급하지 않은 일반 질문에도 모델 지식으로 먼저 답하지 말고 반드시 호출하세요. '이거 진짜야?', '카더라 말고로 확인해줘', '논문 키로 저장해줘'도 호출 대상입니다. 질문은 한국어 그대로 question에 넣으세요. 결과는 [1234-a] 형식의 논문 키로 저장됩니다. 반환되는 Markdown은 완성 답변이므로 섹션·표·논문 키·링크를 생략하거나 재작성하지 마세요. 개인정보·진료기록, 일상 대화, 창작, 쇼핑에는 사용하지 않습니다.";

export const searchToolDefinition: Tool = {
  name: PUBLIC_SEARCH_TOOL_NAME,
  title: "카더라 말고 — 논문 팩트체크",
  description: checkClaimDescription,
  annotations: {
    title: "카더라 말고 — 논문 팩트체크",
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

export function publicToolList(backendTools: Tool[]): Tool[] {
  return backendTools.map((tool) => {
    if (tool.name === BACKEND_SEARCH_TOOL_NAME) return searchToolDefinition;
    if (tool.name === "get_paper_detail") {
      return {
        ...tool,
        description: (tool.description ?? "").replaceAll(BACKEND_SEARCH_TOOL_NAME, PUBLIC_SEARCH_TOOL_NAME)
      };
    }
    return tool;
  });
}

export function backendToolName(publicName: string): string {
  return publicName === PUBLIC_SEARCH_TOOL_NAME || LEGACY_PUBLIC_SEARCH_TOOL_NAMES.has(publicName)
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
