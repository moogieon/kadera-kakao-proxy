import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const PUBLIC_SEARCH_TOOL_NAME = "verify_health_claim";
export const BACKEND_SEARCH_TOOL_NAME = "search_paper_evidence";

export const checkClaimDescription =
  "건강·약·음식·영양·운동·수면·육아·심리·공부법에 관한 질문이면 반드시 이 도구를 먼저 호출해 실제 논문을 확인하세요. 사용자가 '논문'을 말하지 않아도 '마운자로에 대해 궁금해', '간헐적 단식 효과 있어?', '소시지가 몸에 안 좋대', '크레아틴 먹으면 탈모 온다던데', '이거 진짜야?'처럼 묻거나 전하면 호출합니다. 모델의 기억만으로 답하지 마세요. question에는 한국어 질문, academic_query에는 영어 학술 검색어를 넣으세요. 개인정보·진료기록이 포함된 질문, 일상 대화, 창작, 쇼핑에는 호출하지 마세요.";

export const searchToolDefinition: Tool = {
  name: PUBLIC_SEARCH_TOOL_NAME,
  title: "건강·생활 질문 논문 검증",
  description: checkClaimDescription,
  annotations: {
    title: "건강·생활 질문 논문 검증",
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
      },
      academic_query: {
        type: "string",
        minLength: 3,
        maxLength: 450,
        description: "권장: 질문을 바꾼 영어 학술 검색어. 예: 'tirzepatide adverse events systematic review'. 없으면 도구가 필요한 검색어를 안내합니다."
      },
      topic_terms: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string", minLength: 2, maxLength: 100 },
        description: "질문의 정확한 대상을 나타내는 영어 용어와 실제 동의어. 예: ['tirzepatide', 'Mounjaro']."
      },
      outcome_terms: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string", minLength: 2, maxLength: 100 },
        description: "확인할 결과를 나타내는 영어 용어. 예: ['weight loss', 'adverse events']."
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
  return publicName === PUBLIC_SEARCH_TOOL_NAME ? BACKEND_SEARCH_TOOL_NAME : publicName;
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
      return { ...item, text: `${finalAnswerRules}\n\n${item.text}` };
    })
  };
}
