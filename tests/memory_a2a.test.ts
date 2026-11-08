import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/index.js";

test("memory.recall calls flukebase_recall with proper params", async () => {
  let calledUrl = "";
  let calledBody = "";

  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url);
    calledBody = String(init?.body);
    return new Response(
      JSON.stringify({
        result: {
          content: [{ type: "text", text: JSON.stringify({ memories: [{ content: "test memory" }] }) }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const client = createClient({
    baseUrl: "https://mcp.flukebase.me",
    token: "fbk_test",
    projectId: "proj_123",
    fetch: fakeFetch,
  });

  const res = (await client.memory.recall("test query", { tag: "deploy" })) as {
    memories: Array<{ content: string }>;
  };

  assert.match(calledUrl, /\/mcp$/);
  const parsed = JSON.parse(calledBody);
  assert.equal(parsed.params.name, "flukebase_recall");
  assert.equal(parsed.params.arguments.query, "test query");
  assert.equal(parsed.params.arguments.project_id, "proj_123");
  assert.equal(parsed.params.arguments.tag, "deploy");
  assert.equal(res.memories[0].content, "test memory");
});

test("a2a.sendMessage calls flukebase_project_message_send with payload", async () => {
  let calledBody = "";

  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calledBody = String(init?.body);
    return new Response(
      JSON.stringify({
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const client = createClient({
    baseUrl: "https://mcp.flukebase.me",
    token: "fbk_test",
    fetch: fakeFetch,
  });

  await client.a2a.sendMessage({
    id: "msg-123",
    tenantId: "tenant-a",
    fromAgent: "agent-triage",
    toAgent: "agent-lead",
    type: "task_request",
    payload: { task: "review_pr" },
  });

  const parsed = JSON.parse(calledBody);
  assert.equal(parsed.params.name, "flukebase_project_message_send");
  assert.equal(parsed.params.arguments.tenant_id, "tenant-a");
  assert.equal(parsed.params.arguments.from_agent, "agent-triage");
  assert.equal(parsed.params.arguments.to_agent, "agent-lead");
  assert.equal(parsed.params.arguments.payload.task, "review_pr");
});
