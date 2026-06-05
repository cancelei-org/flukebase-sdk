import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createClient,
  verifyBearer,
  redact,
  FlukebaseError,
  FlukebasePaymentError,
} from "../src/index.ts";

// A fetch double that replays programmed responses and records every call.
function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    const body = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(body, {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function client(f: typeof fetch, extra: Record<string, unknown> = {}) {
  return createClient({ token: "test-token", baseUrl: "https://api.test", fetch: f, ...extra });
}

test("verifyBearer is constant-time-safe and exact", () => {
  assert.equal(verifyBearer("Bearer abc123", "abc123"), true);
  assert.equal(verifyBearer("abc123", "abc123"), true); // tolerates missing 'Bearer '
  assert.equal(verifyBearer("Bearer abc123", "abc124"), false); // wrong value
  assert.equal(verifyBearer("Bearer abc", "abc123"), false); // length mismatch
  assert.equal(verifyBearer(null, "abc123"), false);
  assert.equal(verifyBearer("Bearer abc123", undefined), false);
});

test("redact removes bearer tokens and bolt11 invoices", () => {
  const s = redact("auth Bearer sk_live_DEADBEEF.tok paid lnbc25u1pjxyzabcdef done");
  assert.ok(!s.includes("sk_live_DEADBEEF"), s);
  assert.ok(!s.includes("lnbc25u1pjxyz"), s);
  assert.match(s, /Bearer \*\*\*/);
  assert.match(s, /ln\*\*\*/);
});

test("construction is total; a request without a token throws clearly", async () => {
  const prev = { a: process.env.FLUKEBASE_API_TOKEN, b: process.env.FLUKEBASE_PAYMENT_TOKEN };
  delete process.env.FLUKEBASE_API_TOKEN;
  delete process.env.FLUKEBASE_PAYMENT_TOKEN;
  try {
    // Must NOT throw at construction — safe to do `export const fb = createClient()`
    // at module scope even when the build runs without env.
    const fb = createClient({ fetch: (async () => new Response("")) as unknown as typeof fetch });
    // The token error surfaces only when a call is actually made.
    await assert.rejects(() => fb.email.send({ from: "a@x", to: "b@x", subject: "s", text: "t" }), FlukebaseError);
  } finally {
    if (prev.a) process.env.FLUKEBASE_API_TOKEN = prev.a;
    if (prev.b) process.env.FLUKEBASE_PAYMENT_TOKEN = prev.b;
  }
});

test("email.send posts the right shape and bearer", async () => {
  const { f, calls } = mockFetch([{ body: { id: "msg-1", status: "sent" } }]);
  const fb = client(f);
  const res = await fb.email.send({ from: "no-reply@x.me", to: "a@b.com", subject: "Hi", text: "body" });
  assert.deepEqual(res, { id: "msg-1", status: "sent" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.test/api/v1/email/send");
  assert.equal((calls[0]!.init.method as string), "POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    from: "no-reply@x.me",
    to: "a@b.com",
    subject: "Hi",
    text: "body",
  });
});

test("payments.createInvoice sends snake_case and maps the response to camelCase", async () => {
  const { f, calls } = mockFetch([
    {
      body: {
        id: "pay-1",
        payment_hash: "hash-1",
        payment_request: "lnbc1...",
        amount_cents: 500,
        satoshi_equivalent: 812,
        expires_at: "2026-09-02T00:00:00Z",
      },
    },
  ]);
  const fb = client(f, { projectId: "proj-1" });
  const inv = await fb.payments.createInvoice({ externalUserId: "u1", amountCents: 500, purpose: "pro_monthly", memo: "Pro" });
  assert.equal(inv.paymentHash, "hash-1");
  assert.equal(inv.bolt11, "lnbc1...");
  assert.equal(inv.satoshis, 812);
  const sent = JSON.parse(calls[0]!.init.body as string);
  assert.equal(sent.project_id, "proj-1");
  assert.equal(sent.external_user_id, "u1");
  assert.equal(sent.amount_cents, 500);
  assert.equal(sent.currency, "USD");
  assert.equal(sent.expires_in, 300);
});

test("createInvoice without a project throws a payment error", async () => {
  const { f } = mockFetch([{ body: {} }]);
  const fb = client(f); // no projectId
  await assert.rejects(
    () => fb.payments.createInvoice({ externalUserId: "u1", amountCents: 500, purpose: "x" }),
    FlukebasePaymentError,
  );
});

test("checkStatus normalizes unknown statuses to PENDING", async () => {
  const { f } = mockFetch([{ body: { status: "weird" } }, { body: { status: "PAID" } }]);
  const fb = client(f);
  assert.equal(await fb.payments.checkStatus("h"), "PENDING");
  assert.equal(await fb.payments.checkStatus("h"), "PAID");
});

test("transport retries 5xx then succeeds", async () => {
  const { f, calls } = mockFetch([{ status: 502 }, { body: { id: "m", status: "sent" } }]);
  const fb = client(f);
  const res = await fb.email.send({ from: "a@x", to: "b@x", subject: "s", text: "t" });
  assert.equal(res.status, "sent");
  assert.equal(calls.length, 2); // one retry
});

test("transport fails fast on 4xx (no retry)", async () => {
  const { f, calls } = mockFetch([{ status: 400, body: { error: "bad request" } }]);
  const fb = client(f);
  await assert.rejects(() => fb.email.send({ from: "a@x", to: "b@x", subject: "s", text: "t" }), (e: unknown) => {
    assert.ok(e instanceof FlukebaseError);
    assert.equal((e as FlukebaseError).status, 400);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("mcp.call unwraps the structured tool result", async () => {
  const { f } = mockFetch([{ body: { jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: true, n: 7 }) }] } } }]);
  const fb = client(f);
  const out = await fb.mcp.call<{ ok: boolean; n: number }>("flukebase_whoami", {});
  assert.deepEqual(out, { ok: true, n: 7 });
});
