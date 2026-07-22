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
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(redact(message));
    this.name = "FlukebaseError";
    this.status = status;
    this.body = body;
  }
}

export class FlukebasePaymentError extends FlukebaseError {
  constructor(message: string, status?: number, body?: unknown) {
    super(message, status, body);
    this.name = "FlukebasePaymentError";
  }
}

// ─── Secret redaction ────────────────────────────────────────────────────────

const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/=]+/gi;
const BOLT11_RE = /ln(?:bc|tb|bcrt)[0-9a-z]+/gi;

/** Strip bearer tokens and bolt11 invoices from a string before it can reach a
 *  log or an error message. Never log either (treat like access tokens). */
export function redact(s: string): string {
  return s.replace(BEARER_RE, "Bearer ***").replace(BOLT11_RE, "ln***");
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ClientConfig {
  /** Platform base URL. Default: env FLUKEBASE_API_URL or https://mcp.flukebase.me */
  baseUrl?: string;
  /** Bearer token. Default: env FLUKEBASE_TOKEN (canonical), then legacy FLUKEBASE_API_TOKEN / FLUKEBASE_PAYMENT_TOKEN. */
  token?: string;
  /** Default project for payments. Default: env FLUKEBASE_PROJECT_ID. */
  projectId?: string;
  /** Default Mox account to authenticate email sends as (BYOK). Set this when
   *  the sender's local part doesn't match its Mox account name (e.g.
   *  noreply@tenant.com → account `tenant-noreply`), otherwise the platform's
   *  local-part→account resolution falls back to a shared account that isn't
   *  authorized for the address and Mox rejects with `badFrom`. Per-call
   *  `account` overrides this. Default: env FLUKEBASE_EMAIL_ACCOUNT. */
  emailAccount?: string;
  /** Token a settlement webhook will present (constant-time compared in
   *  verifyWebhook). Default: env FLUKEBASE_PAYMENT_TOKEN, then `token`. */
  webhookToken?: string;
  /** Injectable fetch (for tests / Node <18). Default: global fetch. */
  fetch?: typeof fetch;
  /** Retries on 5xx / network / timeout. Default: 2. */
  retries?: number;
  /** Per-request timeout in ms. Default: 15000. */
  timeoutMs?: number;
}

interface ResolvedConfig {
  baseUrl: string;
  token: string;
  projectId: string | undefined;
  emailAccount: string | undefined;
  webhookToken: string | undefined;
  fetch: typeof fetch | undefined;
  retries: number;
  timeoutMs: number;
}

// Resolution is total — it never throws. Missing token/fetch are reported at
// request time, so `export const fb = createClient()` at module scope is safe
// even when the build runs without env (the common Next.js footgun).
function resolveConfig(c: ClientConfig): ResolvedConfig {
  const token =
    c.token ??
    process.env.FLUKEBASE_TOKEN ??
    process.env.FLUKEBASE_API_TOKEN ??
    process.env.FLUKEBASE_PAYMENT_TOKEN ??
    "";
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class Transport {
  constructor(private readonly cfg: ResolvedConfig) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.cfg.token) {
      throw new FlukebaseError("No FlukeBase token — set FLUKEBASE_TOKEN (or pass { token }).");
    }
    const doFetch = this.cfg.fetch;
    if (!doFetch) {
      throw new FlukebaseError("No fetch available — pass { fetch } (Node < 18).");
    }
    const url = `${this.cfg.baseUrl}${path}`;
    let lastErr: unknown;

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
          throw new FlukebaseError(
            `HTTP ${res.status}: ${redact(text).slice(0, 300)}`,
            res.status,
            data,
          );
        }
        return data as T;
      } catch (err) {
        clearTimeout(timer);
        // A definite client error (4xx) is not retryable.
        if (err instanceof FlukebaseError && err.status && err.status < 500) throw err;
        lastErr = err;
        if (attempt < this.cfg.retries) {
          await backoff(attempt);
          continue;
        }
      }
    }
    throw new FlukebaseError(
      `request to ${path} failed: ${redact(errMessage(lastErr))}`,
    );
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000, 100 * 2 ** attempt);
  await new Promise((r) => setTimeout(r, ms));
}

// ─── Email ───────────────────────────────────────────────────────────────────

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Mox account to authenticate the send as (BYOK). Needed when the sender's
   *  local part doesn't match its Mox account name (e.g. noreply@tenant.com →
   *  account `tenant-noreply`); otherwise the platform falls back to a shared
   *  account that isn't authorized for the address and Mox returns `badFrom`.
   *  Defaults to the client's `emailAccount` / FLUKEBASE_EMAIL_ACCOUNT. */
  account?: string;
}

export interface SendTemplateParams {
  from: string;
  to: string;
  subject: string;
  template: string;
  vars: Record<string, unknown>;
  /** See SendEmailParams.account. */
  account?: string;
}

export interface SentEmail {
  id: string;
  status: string;
}

/** Reduce a sender value to a bare email address. The Mox backend behind
 *  /api/v1/email/send rejects the RFC-5322 display-name form
 *  ("Vamos <noreply@vamoslocal.com>") with `badAddress` — only the bare
 *  address is accepted. Idempotent on already-bare addresses. */
export function normalizeFromAddress(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  return (angle ? angle[1]! : from).trim();
}

class EmailApi {
  constructor(
    private readonly t: Transport,
    private readonly defaultAccount: string | undefined,
  ) {}

  /** Send a plain email via POST /api/v1/email/send. */
  send(p: SendEmailParams): Promise<SentEmail> {
    return this.t.request<SentEmail>("POST", "/api/v1/email/send", this.withSender(p));
  }

  /** Send a templated email ({{var}} substitution) via /api/v1/email/send-template. */
  sendTemplate(p: SendTemplateParams): Promise<SentEmail> {
    return this.t.request<SentEmail>("POST", "/api/v1/email/send-template", this.withSender(p));
  }

  // Cross-cutting Mox quirks handled once, for every tenant: the backend needs
  // a BARE `from` address (rejects display names with `badAddress`) and infers
  // the sending account from the `from` local part — falling back to a shared
  // account that may be unauthorized for the address (`badFrom`). Normalize the
  // address and pin the account here instead of in each tenant.
  private withSender<T extends { from: string; account?: string }>(p: T): T {
    const account = p.account ?? this.defaultAccount;
    return {
      ...p,
      from: normalizeFromAddress(p.from),
      ...(account ? { account } : {}),
    };
  }
}

// ─── Payments (Lightning) ────────────────────────────────────────────────────

export interface CreateInvoiceParams {
  externalUserId: string;
  amountCents: number;
  purpose: string;
  memo?: string;
  currency?: string;
  expiresIn?: number;
  callbackUrl?: string;
  /** Overrides the client's default projectId. */
  projectId?: string;
}

export interface Invoice {
  id: string;
  paymentHash: string;
  /** bolt11 — treat like a secret; never log it. */
  bolt11: string;
  amountCents: number;
  satoshis: number;
  expiresAt: string | null;
}

export type PaymentStatus = "PENDING" | "PAID" | "EXPIRED";

class PaymentsApi {
  constructor(
    private readonly t: Transport,
    private readonly defaultProjectId: string | undefined,
    private readonly webhookToken: string | undefined,
  ) {}

  /** Create a USD-priced Lightning invoice via POST /api/v1/payments/invoice. */
  async createInvoice(p: CreateInvoiceParams): Promise<Invoice> {
    const projectId = p.projectId ?? this.defaultProjectId;
    if (!projectId) {
      throw new FlukebasePaymentError(
        "createInvoice needs a projectId — pass it or set FLUKEBASE_PROJECT_ID.",
      );
    }
    const raw = await this.t
      .request<Record<string, unknown>>("POST", "/api/v1/payments/invoice", {
        project_id: projectId,
        external_user_id: p.externalUserId,
        amount_cents: p.amountCents,
        currency: p.currency ?? "USD",
        purpose: p.purpose,
        memo: p.memo,
        expires_in: p.expiresIn ?? INVOICE_EXPIRY_SECONDS,
        ...(p.callbackUrl ? { callback_url: p.callbackUrl } : {}),
      })
      .catch((e: unknown) => {
        throw asPaymentError(e);
      });

    return {
      id: String(raw["id"] ?? ""),
      paymentHash: String(raw["payment_hash"] ?? ""),
      bolt11: String(raw["payment_request"] ?? ""),
      amountCents: Number(raw["amount_cents"] ?? p.amountCents),
      satoshis: Number(raw["satoshi_equivalent"] ?? 0),
      expiresAt: (raw["expires_at"] as string | undefined) ?? null,
    };
  }

  /** Poll a payment's status via GET /api/v1/payments/{hash}/status. */
  async checkStatus(paymentHash: string): Promise<PaymentStatus> {
    const raw = await this.t
      .request<{ status?: string }>(
        "GET",
        `/api/v1/payments/${encodeURIComponent(paymentHash)}/status`,
      )
      .catch((e: unknown) => {
        throw asPaymentError(e);
      });
    const s = (raw.status ?? "PENDING").toUpperCase();
    return s === "PAID" || s === "EXPIRED" ? (s as PaymentStatus) : "PENDING";
  }

  /** Constant-time check that a settlement webhook's `Authorization` header
   *  carries the expected bearer token. Pass the raw header value. */
  verifyWebhook(authorizationHeader: string | null | undefined, expected?: string): boolean {
    return verifyBearer(authorizationHeader, expected ?? this.webhookToken);
  }
}

function asPaymentError(e: unknown): FlukebasePaymentError {
  if (e instanceof FlukebasePaymentError) return e;
  if (e instanceof FlukebaseError) return new FlukebasePaymentError(e.message, e.status, e.body);
  return new FlukebasePaymentError(redact(errMessage(e)));
}

// ─── MCP escape hatch ────────────────────────────────────────────────────────

class McpApi {
  constructor(private readonly t: Transport) {}

  /** Call any `flukebase_*` MCP tool via POST /mcp (JSON-RPC tools/call) and
   *  return its decoded structured result. Use for capabilities not (yet) on
   *  the typed REST surface — memory, search, etc. */
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.t.request<{
      error?: { message?: string };
      result?: { content?: Array<{ text?: string }> };
    }>("POST", "/mcp", {
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
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
    return res?.result as T;
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Constant-time bearer comparison. Returns false on any length/format mismatch. */
export function verifyBearer(
  authorizationHeader: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return false;
  const provided = (authorizationHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class FlukebaseClient {
  readonly email: EmailApi;
  readonly payments: PaymentsApi;
  readonly mcp: McpApi;

  constructor(config: ClientConfig = {}) {
    const cfg = resolveConfig(config);
    const t = new Transport(cfg);
    this.email = new EmailApi(t, cfg.emailAccount);
    this.payments = new PaymentsApi(t, cfg.projectId, cfg.webhookToken);
    this.mcp = new McpApi(t);
  }
}

/** Create a FlukeBase client. With no args it reads FLUKEBASE_API_URL /
 *  FLUKEBASE_TOKEN (or legacy FLUKEBASE_API_TOKEN) / FLUKEBASE_PROJECT_ID
 *  from the environment. */
export function createClient(config: ClientConfig = {}): FlukebaseClient {
  return new FlukebaseClient(config);
}
