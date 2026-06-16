// @flukebase/client — a thin, server-side client for the FlukeBase platform.
//
// It wraps the platform REST API (email, Lightning payments) and the MCP
// `tools/call` endpoint so tenants don't each reimplement auth, retries,
// webhook verification, and secret redaction. The point is "fix once, bump
// everywhere": when a platform-side detail changes (e.g. the Mox login-address
// fix, PR #511), tenants on this client are unaffected — the contract is the
// REST API, and the cross-cutting concerns live here, tested.
//
// Server-only: it reads a bearer token. Never import it into client/browser code.
import { timingSafeEqual } from "node:crypto";
const DEFAULT_BASE_URL = "https://mcp.flukebase.me";
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const INVOICE_EXPIRY_SECONDS = 300;
// ─── Errors ──────────────────────────────────────────────────────────────────
export class FlukebaseError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(redact(message));
        this.name = "FlukebaseError";
        this.status = status;
        this.body = body;
    }
}
export class FlukebasePaymentError extends FlukebaseError {
    constructor(message, status, body) {
        super(message, status, body);
        this.name = "FlukebasePaymentError";
    }
}
// ─── Secret redaction ────────────────────────────────────────────────────────
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/=]+/gi;
const BOLT11_RE = /ln(?:bc|tb|bcrt)[0-9a-z]+/gi;
/** Strip bearer tokens and bolt11 invoices from a string before it can reach a
 *  log or an error message. Never log either (treat like access tokens). */
export function redact(s) {
    return s.replace(BEARER_RE, "Bearer ***").replace(BOLT11_RE, "ln***");
}
// Resolution is total — it never throws. Missing token/fetch are reported at
// request time, so `export const fb = createClient()` at module scope is safe
// even when the build runs without env (the common Next.js footgun).
function resolveConfig(c) {
    const token = c.token ?? process.env.FLUKEBASE_API_TOKEN ?? process.env.FLUKEBASE_PAYMENT_TOKEN ?? "";
    return {
        baseUrl: (c.baseUrl ?? process.env.FLUKEBASE_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
        token,
        projectId: c.projectId ?? process.env.FLUKEBASE_PROJECT_ID,
        emailAccount: c.emailAccount ?? process.env.FLUKEBASE_EMAIL_ACCOUNT,
        webhookToken: c.webhookToken ?? process.env.FLUKEBASE_PAYMENT_TOKEN ?? token ?? undefined,
        fetch: c.fetch ?? globalThis.fetch,
        retries: c.retries ?? DEFAULT_RETRIES,
        timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
}
// ─── Transport ───────────────────────────────────────────────────────────────
function safeJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
class Transport {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    async request(method, path, body) {
        if (!this.cfg.token) {
            throw new FlukebaseError("No FlukeBase token — set FLUKEBASE_API_TOKEN (or pass { token }).");
        }
        const doFetch = this.cfg.fetch;
        if (!doFetch) {
            throw new FlukebaseError("No fetch available — pass { fetch } (Node < 18).");
        }
        const url = `${this.cfg.baseUrl}${path}`;
        let lastErr;
        for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
            try {
                const res = await doFetch(url, {
                    method,
                    headers: {
                        Authorization: `Bearer ${this.cfg.token}`,
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: controller.signal,
                });
                clearTimeout(timer);
                const text = await res.text();
                const data = text ? safeJson(text) : undefined;
                if (!res.ok) {
                    // Retry transient server errors; fail fast on 4xx.
                    if (res.status >= 500 && attempt < this.cfg.retries) {
                        lastErr = new FlukebaseError(`HTTP ${res.status}`, res.status, data);
                        await backoff(attempt);
                        continue;
                    }
                    throw new FlukebaseError(`HTTP ${res.status}: ${redact(text).slice(0, 300)}`, res.status, data);
                }
                return data;
            }
            catch (err) {
                clearTimeout(timer);
                // A definite client error (4xx) is not retryable.
                if (err instanceof FlukebaseError && err.status && err.status < 500)
                    throw err;
                lastErr = err;
                if (attempt < this.cfg.retries) {
                    await backoff(attempt);
                    continue;
                }
            }
        }
        throw new FlukebaseError(`request to ${path} failed: ${redact(errMessage(lastErr))}`);
    }
}
function errMessage(e) {
    if (e instanceof Error)
        return e.message;
    return String(e);
}
async function backoff(attempt) {
    const ms = Math.min(1000, 100 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, ms));
}
/** Reduce a sender value to a bare email address. The Mox backend behind
 *  /api/v1/email/send rejects the RFC-5322 display-name form
 *  ("Vamos <noreply@vamoslocal.com>") with `badAddress` — only the bare
 *  address is accepted. Idempotent on already-bare addresses. */
export function normalizeFromAddress(from) {
    const angle = from.match(/<([^>]+)>/);
    return (angle ? angle[1] : from).trim();
}
class EmailApi {
    t;
    defaultAccount;
    constructor(t, defaultAccount) {
        this.t = t;
        this.defaultAccount = defaultAccount;
    }
    /** Send a plain email via POST /api/v1/email/send. */
    send(p) {
        return this.t.request("POST", "/api/v1/email/send", this.withSender(p));
    }
    /** Send a templated email ({{var}} substitution) via /api/v1/email/send-template. */
    sendTemplate(p) {
        return this.t.request("POST", "/api/v1/email/send-template", this.withSender(p));
    }
    // Cross-cutting Mox quirks handled once, for every tenant: the backend needs
    // a BARE `from` address (rejects display names with `badAddress`) and infers
    // the sending account from the `from` local part — falling back to a shared
    // account that may be unauthorized for the address (`badFrom`). Normalize the
    // address and pin the account here instead of in each tenant.
    withSender(p) {
        const account = p.account ?? this.defaultAccount;
        return {
            ...p,
            from: normalizeFromAddress(p.from),
            ...(account ? { account } : {}),
        };
    }
}
class PaymentsApi {
    t;
    defaultProjectId;
    webhookToken;
    constructor(t, defaultProjectId, webhookToken) {
        this.t = t;
        this.defaultProjectId = defaultProjectId;
        this.webhookToken = webhookToken;
    }
    /** Create a USD-priced Lightning invoice via POST /api/v1/payments/invoice. */
    async createInvoice(p) {
        const projectId = p.projectId ?? this.defaultProjectId;
        if (!projectId) {
            throw new FlukebasePaymentError("createInvoice needs a projectId — pass it or set FLUKEBASE_PROJECT_ID.");
        }
        const raw = await this.t
            .request("POST", "/api/v1/payments/invoice", {
            project_id: projectId,
            external_user_id: p.externalUserId,
            amount_cents: p.amountCents,
            currency: p.currency ?? "USD",
            purpose: p.purpose,
            memo: p.memo,
            expires_in: p.expiresIn ?? INVOICE_EXPIRY_SECONDS,
            ...(p.callbackUrl ? { callback_url: p.callbackUrl } : {}),
        })
            .catch((e) => {
            throw asPaymentError(e);
        });
        return {
            id: String(raw["id"] ?? ""),
            paymentHash: String(raw["payment_hash"] ?? ""),
            bolt11: String(raw["payment_request"] ?? ""),
            amountCents: Number(raw["amount_cents"] ?? p.amountCents),
            satoshis: Number(raw["satoshi_equivalent"] ?? 0),
            expiresAt: raw["expires_at"] ?? null,
        };
    }
    /** Poll a payment's status via GET /api/v1/payments/{hash}/status. */
    async checkStatus(paymentHash) {
        const raw = await this.t
            .request("GET", `/api/v1/payments/${encodeURIComponent(paymentHash)}/status`)
            .catch((e) => {
            throw asPaymentError(e);
        });
        const s = (raw.status ?? "PENDING").toUpperCase();
        return s === "PAID" || s === "EXPIRED" ? s : "PENDING";
    }
    /** Constant-time check that a settlement webhook's `Authorization` header
     *  carries the expected bearer token. Pass the raw header value. */
    verifyWebhook(authorizationHeader, expected) {
        return verifyBearer(authorizationHeader, expected ?? this.webhookToken);
    }
}
function asPaymentError(e) {
    if (e instanceof FlukebasePaymentError)
        return e;
    if (e instanceof FlukebaseError)
        return new FlukebasePaymentError(e.message, e.status, e.body);
    return new FlukebasePaymentError(redact(errMessage(e)));
}
// ─── MCP escape hatch ────────────────────────────────────────────────────────
class McpApi {
    t;
    constructor(t) {
        this.t = t;
    }
    /** Call any `flukebase_*` MCP tool via POST /mcp (JSON-RPC tools/call) and
     *  return its decoded structured result. Use for capabilities not (yet) on
     *  the typed REST surface — memory, search, etc. */
    async call(tool, args = {}) {
        const res = await this.t.request("POST", "/mcp", {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool, arguments: args },
        });
        if (res?.error) {
            throw new FlukebaseError(`mcp ${tool}: ${redact(res.error.message ?? "error")}`);
        }
        const text = res?.result?.content?.[0]?.text;
        if (typeof text === "string") {
            try {
                return JSON.parse(text);
            }
            catch {
                return text;
            }
        }
        return res?.result;
    }
}
// ─── Shared helpers ──────────────────────────────────────────────────────────
/** Constant-time bearer comparison. Returns false on any length/format mismatch. */
export function verifyBearer(authorizationHeader, expected) {
    if (!expected)
        return false;
    const provided = (authorizationHeader ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!provided)
        return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
// ─── Client ──────────────────────────────────────────────────────────────────
export class FlukebaseClient {
    email;
    payments;
    mcp;
    constructor(config = {}) {
        const cfg = resolveConfig(config);
        const t = new Transport(cfg);
        this.email = new EmailApi(t, cfg.emailAccount);
        this.payments = new PaymentsApi(t, cfg.projectId, cfg.webhookToken);
        this.mcp = new McpApi(t);
    }
}
/** Create a FlukeBase client. With no args it reads FLUKEBASE_API_URL /
 *  FLUKEBASE_API_TOKEN / FLUKEBASE_PROJECT_ID from the environment. */
export function createClient(config = {}) {
    return new FlukebaseClient(config);
}
//# sourceMappingURL=index.js.map