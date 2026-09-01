import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  BACKEND_SEARCH_TOOL_NAME,
  PUBLIC_SEARCH_TOOL_NAME,
  backendToolName,
  checkClaimDescription,
  publicToolList,
  reinforceSearchResult
} from "../src/toolManifest.js";

const backendTools: Tool[] = [
  {
    name: BACKEND_SEARCH_TOOL_NAME,
    description: "old search description",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_paper_detail",
    description: "Open a paper returned by search_paper_evidence.",
    inputSchema: { type: "object", properties: {} }
  }
];

test("publishes one intent-first search tool without retaining the old public name", () => {
  const tools = publicToolList(backendTools);

  assert.deepEqual(tools.map((tool) => tool.name), [PUBLIC_SEARCH_TOOL_NAME, "get_paper_detail"]);
  assert.equal(PUBLIC_SEARCH_TOOL_NAME, "answer_health_question_with_papers");
  assert.equal(tools[0]?.title, "건강 질문에 논문으로 답하기");
  assert.deepEqual(tools[0]?.inputSchema.required, ["question"]);
  assert.match(tools[0]?.description ?? "", /^사용자의 건강·의학/);
  assert.match(tools[0]?.description ?? "", /마운자로 효과와 부작용이 궁금해/);
  assert.match(tools[0]?.description ?? "", /논문을 말하지 않은 일반적인 건강 질문도/);
  assert.ok(Buffer.byteLength(checkClaimDescription, "utf8") < 1024);
  assert.doesNotMatch(tools[1]?.description ?? "", /search_paper_evidence/);
  assert.match(tools[1]?.description ?? "", /answer_health_question_with_papers/);
});

test("maps the public intent name to the existing backend implementation", () => {
  assert.equal(backendToolName(PUBLIC_SEARCH_TOOL_NAME), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("verify_health_claim"), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName(BACKEND_SEARCH_TOOL_NAME), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("get_paper_detail"), "get_paper_detail");
});

test("puts citation and follow-up rules before the backend evidence", () => {
  const original: CallToolResult = {
    content: [{ type: "text", text: "## 카더라 말고 논문 근거" }],
    structuredContent: { papers: [{ paper_id: "1234-a" }] }
  };

  const reinforced = reinforceSearchResult(original);
  const text = reinforced.content[0]?.type === "text" ? reinforced.content[0].text : "";

  assert.match(text, /^최종 답변 필수 규칙:/);
  assert.match(text, /\[1234-a\]/);
  assert.match(text, /별점/);
  assert.match(text, /논문 키를 말하면/);
  assert.deepEqual(reinforced.structuredContent, original.structuredContent);
});
