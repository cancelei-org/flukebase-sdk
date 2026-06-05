# @flukebase/client

A thin, server-side client for the [FlukeBase](https://mcp.flukebase.me) platform — **email**, **Lightning payments**, and a generic **MCP** escape hatch — so tenant apps stop reimplementing (and re-bugging) the same client in every repo.

The contract is the platform REST API. Cross-cutting concerns — bearer auth, retries, timeouts, **constant-time webhook verification**, and **secret redaction** (never logs bolt11/tokens) — live here, tested once. When a platform detail changes (e.g. the Mox login-address fix, PR #511), apps on this client are unaffected.

> Server-only. It reads a bearer token — never import it into browser/client code.

## Install

```bash
# Until it's on npm, install from git (pinned to a tag):
npm i github:cancelei-org/flukebase-sdk#v0.1.0
```

## Use

```ts
import { createClient } from "@flukebase/client";

// Reads FLUKEBASE_API_URL, FLUKEBASE_API_TOKEN, FLUKEBASE_PROJECT_ID from env by default.
const fb = createClient();

// Email — POST /api/v1/email/send (the #511-fixed path)
await fb.email.send({
  from: "no-reply@yourtenant.flukebase.me",
  to: user.email,
  subject: "Welcome",
  text: "…",
  html: "<p>…</p>",
});

// Lightning payments
const invoice = await fb.payments.createInvoice({
  externalUserId: user.id,
  amountCents: 500,
  purpose: "pro_monthly",
  memo: "Pro — monthly",
  callbackUrl: `${process.env.APP_URL}/api/webhooks/flukebase-payment`,
});
const status = await fb.payments.checkStatus(invoice.paymentHash); // PENDING | PAID | EXPIRED

// Settlement webhook (constant-time)
if (!fb.payments.verifyWebhook(req.headers.get("authorization"))) return unauthorized();

// Anything else on the platform, via MCP:
await fb.mcp.call("flukebase_remember", { content: "…", project_id: "…" });
```

## Config

`createClient({ baseUrl?, token?, projectId?, webhookToken?, fetch?, retries?, timeoutMs? })`.
All optional; env fallbacks: `FLUKEBASE_API_URL`, `FLUKEBASE_API_TOKEN` (or `FLUKEBASE_PAYMENT_TOKEN`), `FLUKEBASE_PROJECT_ID`.

## Develop

```bash
npm install
npm test        # tsx --test
npm run build   # tsc → dist/ (committed so git-dependency consumers don't build)
```

Roadmap: publish to npm; Ruby gem + Go module ports for the non-Next.js tenants.
