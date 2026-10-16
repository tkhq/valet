import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from "@valet/engine";

export const REPORT_URL = "https://docs-analytics.vercel.app/api/report";

/** The deployment-level report token. The operator sets it once on the API
 * (`.env` locally, `api.secrets.docsAnalyticsToken` in the Helm chart). No
 * user, team, or org admin connects anything: every session in every org
 * reports through this one token. */
export const TOKEN_ENV = "DOCS_ANALYTICS_TOKEN";

const dateParameter = Type.Optional(
  Type.String({
    pattern: "^(?:\\d{4}-\\d{2}-\\d{2}|today|yesterday)$",
    description: "Inclusive report endpoint. Use YYYY-MM-DD, today, or yesterday. Omit to use the report endpoint default.",
  }),
);

const reportParameters = Type.Object({
  from: dateParameter,
  to: dateParameter,
  format: Type.Union([Type.Literal("json"), Type.Literal("md")], {
    description: "json preserves structured analytics data. md returns the report Markdown.",
  }),
});

type ReportArgs = Static<typeof reportParameters>;

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

function reportUrl(args: ReportArgs): string {
  const url = new URL(REPORT_URL);
  url.searchParams.set("format", args.format);
  if (args.from) url.searchParams.set("from", args.from);
  if (args.to) url.searchParams.set("to", args.to);
  return url.toString();
}

function isSafeBearerToken(token: string): boolean {
  return /^[\x21-\x7e]+$/.test(token);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactCredential(value: string, token: string): string {
  const escapedToken = escapeRegExp(token);
  return value
    .replace(new RegExp(`Bearer\\s+${escapedToken}`, "gi"), "Bearer [redacted]")
    .replace(new RegExp(escapedToken, "g"), "[redacted]");
}

function jsonErrorDetail(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return undefined;
    const error = parsed.error;
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

async function errorDetail(response: Response, token: string): Promise<string | undefined> {
  try {
    const body = await response.text();
    const detail = redactCredential(jsonErrorDetail(body) ?? body, token)
      .replace(/\s+/g, " ")
      .trim();
    return detail === "" ? undefined : detail.slice(0, 1_000);
  } catch {
    return undefined;
  }
}

async function reportError(response: Response, token: string): Promise<PluginActionResult> {
  if (response.status === 400) {
    const detail = await errorDetail(response, token);
    return {
      success: false,
      error: detail
        ? `Docs Analytics rejected the report parameters: ${detail}`
        : "Docs Analytics rejected the report parameters. Use inclusive YYYY-MM-DD, today, or yesterday values for from and to.",
    };
  }
  if (response.status === 401) {
    return {
      success: false,
      error: `Docs Analytics rejected the server token. Ask the Valet operator to renew ${TOKEN_ENV} on the API.`,
    };
  }
  if (response.status === 403) {
    return {
      success: false,
      error: `Docs Analytics denied access to this report. Ask the Valet operator to check ${TOKEN_ENV} on the API.`,
    };
  }
  if (response.status === 429) {
    return {
      success: false,
      error: "Docs Analytics rate limited this report request. Wait before trying again.",
    };
  }
  if (response.status === 500 || response.status === 503) {
    return {
      success: false,
      error: "Docs Analytics could not generate the report. Try again later; if the error continues, contact the report service owner.",
    };
  }
  return {
    success: false,
    error: `Docs Analytics returned HTTP ${response.status}. Try again later; if the error continues, contact the report service owner.`,
  };
}

async function executeReport(args: ReportArgs, ctx: PluginActionContext): Promise<PluginActionResult> {
  const token = process.env[TOKEN_ENV];
  if (!token) {
    return {
      success: false,
      error: `Docs Analytics is not configured on this server. Set ${TOKEN_ENV} in the API environment and restart the API.`,
    };
  }
  if (!isSafeBearerToken(token)) {
    return {
      success: false,
      error: `${TOKEN_ENV} is malformed. Set it to the report token with no spaces or line breaks, then restart the API.`,
    };
  }

  let response: Response;
  try {
    response = await fetch(reportUrl(args), {
      headers: { authorization: `Bearer ${token}` },
      signal: ctx.signal,
    });
  } catch {
    return {
      success: false,
      error: "Docs Analytics could not be reached. Check the service status and try again later.",
    };
  }
  if (!response.ok) return reportError(response, token);

  try {
    if (args.format === "md") return { success: true, data: await response.text() };
    return { success: true, data: await response.json() };
  } catch {
    return {
      success: false,
      error: args.format === "json"
        ? "Docs Analytics returned an invalid JSON report. Ask the report service owner to check the endpoint."
        : "Docs Analytics report content could not be read. Try again later; if the error continues, contact the report service owner.",
    };
  }
}

export const docsAnalyticsPlugin: ActionPlugin = {
  service: "docs_analytics",
  description: "Read-only documentation analytics reports.",
  // No credential: the report token is a deployment setting (`TOKEN_ENV`),
  // so the tool is listed for every session and never probed for a
  // connected account.
  actions: [
    action(reportParameters)({
      id: "docs_analytics.report",
      name: "Docs Analytics Report",
      description: "Get a read-only documentation analytics report. Date endpoints are inclusive. JSON retains report fields, including coverage.missing_days.",
      riskLevel: "low",
      execute: executeReport,
    }),
  ],
};
