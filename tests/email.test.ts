import assert from "node:assert/strict";
import { test } from "node:test";

import { createClient, normalizeFromAddress } from "../src/index.ts";

// A fetch double that records the parsed JSON body of each call.
function capture() {
  const calls: Array<{ url: string; body: any }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ id: "e1", status: "sent" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function client(f: typeof fetch, extra: Record<string, unknown> = {}) {
  return createClient({ token: "t", baseUrl: "https://api.test", fetch: f, ...extra });
}

test("normalizeFromAddress strips the display name to a bare address", () => {
  assert.equal(normalizeFromAddress("Vamos <noreply@vamoslocal.com>"), "noreply@vamoslocal.com");
  assert.equal(normalizeFromAddress("noreply@vamoslocal.com"), "noreply@vamoslocal.com");
  assert.equal(normalizeFromAddress("  noreply@x.com  "), "noreply@x.com");
  assert.equal(normalizeFromAddress("Name < a@b.co >"), "a@b.co");
});

test("email.send normalizes the from address before POSTing", async () => {
  const { f, calls } = capture();
  await client(f).email.send({
    from: "Vamos <noreply@vamoslocal.com>",
    to: "u@e.com",
    subject: "s",
    text: "t",
  });
  assert.equal(calls[0]!.body.from, "noreply@vamoslocal.com");
});

test("email.send pins the account from the emailAccount config", async () => {
  const { f, calls } = capture();
  await client(f, { emailAccount: "vamos-noreply" }).email.send({
    from: "noreply@vamoslocal.com",
    to: "u@e.com",
    subject: "s",
    text: "t",
  });
  assert.equal(calls[0]!.body.account, "vamos-noreply");
});

test("an explicit account param overrides the configured default", async () => {
  const { f, calls } = capture();
  await client(f, { emailAccount: "default-acct" }).email.send({
    from: "x@y.com",
    to: "u@e.com",
    subject: "s",
    text: "t",
    account: "explicit",
  });
  assert.equal(calls[0]!.body.account, "explicit");
});

test("no account key is sent when none is configured or passed", async () => {
  const { f, calls } = capture();
  await client(f).email.send({ from: "x@y.com", to: "u@e.com", subject: "s", text: "t" });
  assert.equal("account" in calls[0]!.body, false);
});

test("email account falls back to FLUKEBASE_EMAIL_ACCOUNT env", async () => {
  const { f, calls } = capture();
  process.env.FLUKEBASE_EMAIL_ACCOUNT = "env-acct";
  try {
    await client(f).email.send({ from: "x@y.com", to: "u@e.com", subject: "s", text: "t" });
    assert.equal(calls[0]!.body.account, "env-acct");
  } finally {
    delete process.env.FLUKEBASE_EMAIL_ACCOUNT;
  }
});

test("sendTemplate also normalizes from and pins the account", async () => {
  const { f, calls } = capture();
  await client(f, { emailAccount: "acct" }).email.sendTemplate({
    from: "Brand <hi@x.com>",
    to: "u@e.com",
    subject: "s",
    template: "T",
    vars: {},
  });
  assert.equal(calls[0]!.body.from, "hi@x.com");
  assert.equal(calls[0]!.body.account, "acct");
});
