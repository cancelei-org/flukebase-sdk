export declare class FlukebaseError extends Error {
    readonly status?: number;
    readonly body?: unknown;
    constructor(message: string, status?: number, body?: unknown);
}
export declare class FlukebasePaymentError extends FlukebaseError {
    constructor(message: string, status?: number, body?: unknown);
}
/** Strip bearer tokens and bolt11 invoices from a string before it can reach a
 *  log or an error message. Never log either (treat like access tokens). */
export declare function redact(s: string): string;
export interface ClientConfig {
    /** Platform base URL. Default: env FLUKEBASE_API_URL or https://mcp.flukebase.me */
    baseUrl?: string;
    /** Bearer token. Default: env FLUKEBASE_API_TOKEN or FLUKEBASE_PAYMENT_TOKEN. */
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
declare class Transport {
    private readonly cfg;
    constructor(cfg: ResolvedConfig);
    request<T>(method: string, path: string, body?: unknown): Promise<T>;
}
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
export declare function normalizeFromAddress(from: string): string;
declare class EmailApi {
    private readonly t;
    private readonly defaultAccount;
    constructor(t: Transport, defaultAccount: string | undefined);
    /** Send a plain email via POST /api/v1/email/send. */
    send(p: SendEmailParams): Promise<SentEmail>;
    /** Send a templated email ({{var}} substitution) via /api/v1/email/send-template. */
    sendTemplate(p: SendTemplateParams): Promise<SentEmail>;
    private withSender;
}
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
declare class PaymentsApi {
    private readonly t;
    private readonly defaultProjectId;
    private readonly webhookToken;
    constructor(t: Transport, defaultProjectId: string | undefined, webhookToken: string | undefined);
    /** Create a USD-priced Lightning invoice via POST /api/v1/payments/invoice. */
    createInvoice(p: CreateInvoiceParams): Promise<Invoice>;
    /** Poll a payment's status via GET /api/v1/payments/{hash}/status. */
    checkStatus(paymentHash: string): Promise<PaymentStatus>;
    /** Constant-time check that a settlement webhook's `Authorization` header
     *  carries the expected bearer token. Pass the raw header value. */
    verifyWebhook(authorizationHeader: string | null | undefined, expected?: string): boolean;
}
declare class McpApi {
    private readonly t;
    constructor(t: Transport);
    /** Call any `flukebase_*` MCP tool via POST /mcp (JSON-RPC tools/call) and
     *  return its decoded structured result. Use for capabilities not (yet) on
     *  the typed REST surface — memory, search, etc. */
    call<T = unknown>(tool: string, args?: Record<string, unknown>): Promise<T>;
}
/** Constant-time bearer comparison. Returns false on any length/format mismatch. */
export declare function verifyBearer(authorizationHeader: string | null | undefined, expected: string | undefined): boolean;
export declare class FlukebaseClient {
    readonly email: EmailApi;
    readonly payments: PaymentsApi;
    readonly mcp: McpApi;
    constructor(config?: ClientConfig);
}
/** Create a FlukeBase client. With no args it reads FLUKEBASE_API_URL /
 *  FLUKEBASE_API_TOKEN / FLUKEBASE_PROJECT_ID from the environment. */
export declare function createClient(config?: ClientConfig): FlukebaseClient;
export {};
//# sourceMappingURL=index.d.ts.map