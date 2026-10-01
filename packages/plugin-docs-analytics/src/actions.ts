import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from "@valet/engine";

export const REPORT_URL = "https://docs-analytics.vercel.app/api/report";

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

async function errorDetail(response: Response): Promise<string | undefined> {
  try {
    const detail = (await response.text()).replace(/\s+/g, " ").trim();
    return detail === "" ? undefined : detail.slice(0, 1_000);
  } catch {
    return undefined;
  }
}

async function reportError(response: Response): Promise<PluginActionResult> {
  if (response.status === 400) {
    const detail = await errorDetail(response);
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
      error: "Docs Analytics rejected the organization credential. Ask an organization admin to add, renew, or replace the Docs Analytics credential.",
    };
  }
  if (response.status === 403) {
    return {
      success: false,
      error: "Docs Analytics denied access to this report. Ask an organization admin to verify the Docs Analytics organization credential.",
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
  const token = (await ctx.credentials.get())?.accessToken;
  if (!token) {
    return {
      success: false,
      error: "Docs Analytics organization credential is not configured. Ask an organization admin to add the credential.",
    };
  }
  if (!isSafeBearerToken(token)) {
    return {
      success: false,
      error: "Docs Analytics organization credential is malformed. Ask an organization admin to replace the credential.",
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
  if (!response.ok) return reportError(response);

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
  requiresCredential: true,
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
