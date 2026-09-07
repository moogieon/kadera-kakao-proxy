import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  BACKEND_SEARCH_TOOL_NAME,
  PUBLIC_SEARCH_TOOL_NAME,
  backendToolName,
  checkClaimDescription,
  parsePublicToolConfig,
  publicServerInstructions,
  publicToolList,
  reinforceSearchResult,
  toBackendSearchArguments
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

test("publishes a natural answer intent without repeating the MCP prefix", () => {
  const tools = publicToolList(backendTools);

  assert.deepEqual(tools.map((tool) => tool.name), [PUBLIC_SEARCH_TOOL_NAME, "get_paper_detail"]);
  assert.equal(PUBLIC_SEARCH_TOOL_NAME, "answer_question_with_research");
  assert.equal(tools[0]?.title, "논문 근거로 질문 답하기");
  assert.deepEqual(tools[0]?.inputSchema.required, ["claim_or_topic"]);
  assert.deepEqual(Object.keys(tools[0]?.inputSchema.properties ?? {}), ["claim_or_topic"]);
  assert.match(tools[0]?.description ?? "", /^Kadera\(카더라 말고\) answers Korean/);
  assert.doesNotMatch(tools[0]?.description ?? "", /Always call|user.*prompt|verbatim/i);
  assert.match(tools[0]?.description ?? "", /education/);
  assert.match(tools[0]?.description ?? "", /effects, benefits, risks, side effects, safety, comparisons/);
  assert.match(tools[0]?.description ?? "", /reusable paper IDs/);
  assert.ok(Buffer.byteLength(checkClaimDescription, "utf8") < 800);
  assert.doesNotMatch(tools[1]?.description ?? "", /search_paper_evidence/);
  assert.match(tools[1]?.description ?? "", /answer_question_with_research/);
  assert.equal(tools[0]?.annotations?.idempotentHint, true);
});

test("instructs the host to search before answering broad Korean questions", () => {
  const instructions = publicServerInstructions();
  assert.match(instructions, /Use answer_question_with_research/);
  assert.match(instructions, /evidence-based answer/);
  assert.match(instructions, /call get_paper_detail/);
});

test("summarizes the public claim field into the backend question contract", () => {
  assert.deepEqual(
    toBackendSearchArguments({ claim_or_topic: "제로 탄산의 장기 건강 영향" }),
    { question: "제로 탄산의 장기 건강 영향" }
  );
  assert.deepEqual(
    toBackendSearchArguments({ question: "기존 채팅에 저장된 요청" }),
    { question: "기존 채팅에 저장된 요청" }
  );
});

test("does not prefix answer-writing instructions to an already completed Kadera answer", () => {
  const answer = "## 현재 판단\n**한줄 결론:** 완성된 답변입니다.";
  const completed = reinforceSearchResult({ content: [{ type: "text", text: answer }] });
  assert.equal(completed.content[0]?.type, "text");
  if (completed.content[0]?.type === "text") assert.equal(completed.content[0].text, answer);
});

test("maps the public intent name to the existing backend implementation", () => {
  assert.equal(backendToolName(PUBLIC_SEARCH_TOOL_NAME), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("kadera_answer_health_question_with_papers"), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("kadera_factcheck_with_papers"), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("answer_health_question_with_papers"), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("verify_health_claim"), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName(BACKEND_SEARCH_TOOL_NAME), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("get_paper_detail"), "get_paper_detail");
});

test("accepts safe remote metadata and maps its current and legacy names", () => {
  const config = parsePublicToolConfig({
    publicName: "kadera_research_factcheck",
    title: "카더라 연구 확인",
    description: "실제 논문으로 질문을 확인합니다.",
    aliases: ["old_kadera_tool", "old_kadera_tool"]
  });

  assert.deepEqual(config.aliases, ["old_kadera_tool"]);
  assert.equal(backendToolName("kadera_research_factcheck", config), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(backendToolName("old_kadera_tool", config), BACKEND_SEARCH_TOOL_NAME);
  assert.equal(publicToolList(backendTools, config)[0]?.name, "kadera_research_factcheck");
});

test("rejects unsafe or oversized remote metadata", () => {
  assert.throws(() => parsePublicToolConfig({
    publicName: "invalid-name",
    title: "카더라",
    description: "설명",
    aliases: []
  }), /Invalid public tool name/);
  assert.throws(() => parsePublicToolConfig({
    publicName: "valid_name",
    title: "카더라",
    description: "가".repeat(400),
    aliases: []
  }), /Invalid public tool description/);
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
