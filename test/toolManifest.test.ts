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
  assert.equal(tools[0]?.title, "건강·생활 질문 논문 검증");
  assert.deepEqual(tools[0]?.inputSchema.required, ["question"]);
  assert.match(tools[0]?.description ?? "", /^건강·약·음식/);
  assert.ok(Buffer.byteLength(checkClaimDescription, "utf8") < 1024);
  assert.doesNotMatch(tools[1]?.description ?? "", /search_paper_evidence/);
  assert.match(tools[1]?.description ?? "", /verify_health_claim/);
});

test("maps the public intent name to the existing backend implementation", () => {
  assert.equal(backendToolName(PUBLIC_SEARCH_TOOL_NAME), BACKEND_SEARCH_TOOL_NAME);
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
