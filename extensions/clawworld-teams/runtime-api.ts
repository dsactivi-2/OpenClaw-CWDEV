import type { IncomingMessage, ServerResponse } from "node:http";
import type { Application } from "express";

export interface ClawworldTeamsPluginConfig {
  dashboardPath: string;
  dashboardTitle: string;
  apiBaseUrl: string;
  brandLabel: string;
}

export interface ClawworldTeamsStatusSnapshot {
  pluginId: "clawworld-teams";
  brandLabel: string;
  dashboardPath: string;
  dashboardTitle: string;
  apiBaseUrl: string | null;
  integrationMode: "embedded-dashboard" | "bridge-only";
  requestPath: string | null;
  generatedAt: string;
}

function readConfigRecord(pluginConfig: unknown): Record<string, unknown> | undefined {
  return pluginConfig !== null && typeof pluginConfig === "object"
    ? (pluginConfig as Record<string, unknown>)
    : undefined;
}

function readStringValue(
  pluginConfig: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = pluginConfig?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeDashboardPath(value: string | undefined): string {
  const fallback = "/clawworld";
  if (!value) {
    return fallback;
  }
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  const trimmed = prefixed !== "/" ? prefixed.replace(/\/+$/, "") : prefixed;
  return trimmed.length > 0 ? trimmed : fallback;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendResponse(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | undefined,
  method: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

export function resolveClawworldTeamsPluginConfig(
  pluginConfig: unknown,
): ClawworldTeamsPluginConfig {
  const config = readConfigRecord(pluginConfig);
  return {
    dashboardPath: normalizeDashboardPath(readStringValue(config, "dashboardPath")),
    dashboardTitle: readStringValue(config, "dashboardTitle") ?? "ClawWorld Control",
    apiBaseUrl: readStringValue(config, "apiBaseUrl") ?? "",
    brandLabel: readStringValue(config, "brandLabel") ?? "ClawWorld Teams",
  };
}

export function buildClawworldTeamsStatusSnapshot(
  config: ClawworldTeamsPluginConfig,
  requestPath: string | null = null,
): ClawworldTeamsStatusSnapshot {
  return {
    pluginId: "clawworld-teams",
    brandLabel: config.brandLabel,
    dashboardPath: config.dashboardPath,
    dashboardTitle: config.dashboardTitle,
    apiBaseUrl: config.apiBaseUrl.length > 0 ? config.apiBaseUrl : null,
    integrationMode: config.apiBaseUrl.length > 0 ? "embedded-dashboard" : "bridge-only",
    requestPath,
    generatedAt: new Date().toISOString(),
  };
}

export function renderClawworldTeamsDashboardHtml(status: ClawworldTeamsStatusSnapshot): string {
  const apiBaseUrlLabel = status.apiBaseUrl ?? "not configured yet";
  const integrationLabel =
    status.integrationMode === "embedded-dashboard" ? "Connected bridge" : "Dashboard shell ready";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(status.dashboardTitle)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --panel: rgba(17, 24, 39, 0.9);
        --text: #f8fafc;
        --muted: #94a3b8;
        --accent: #60a5fa;
        --border: rgba(148, 163, 184, 0.2);
      }
      body {
        margin: 0;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, #1e293b, var(--bg));
        color: var(--text);
      }
      main {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px;
        box-sizing: border-box;
      }
      .card {
        width: min(960px, 100%);
        border: 1px solid var(--border);
        border-radius: 24px;
        background: var(--panel);
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.45);
        padding: 32px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.18em;
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
      }
      h1 {
        margin: 12px 0 8px;
        font-size: clamp(32px, 4vw, 56px);
        line-height: 1.04;
      }
      p, li {
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
        margin: 28px 0;
      }
      .tile {
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
        background: rgba(15, 23, 42, 0.38);
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .value {
        margin-top: 8px;
        font-size: 18px;
        font-weight: 650;
        color: var(--text);
        word-break: break-word;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 8px 14px;
        background: rgba(96, 165, 250, 0.14);
        color: #bfdbfe;
        font-weight: 650;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 24px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 14px;
        padding: 12px 16px;
        text-decoration: none;
        color: #0f172a;
        background: var(--accent);
        font-weight: 700;
      }
      .button.secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
      }
      code {
        background: rgba(15, 23, 42, 0.72);
        padding: 2px 6px;
        border-radius: 8px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <div class="eyebrow">${escapeHtml(status.brandLabel)}</div>
        <h1>${escapeHtml(status.dashboardTitle)}</h1>
        <p>${escapeHtml(
          "This bundled plugin is the integration seam for the ClawWorld dashboard inside OpenClaw.",
        )}</p>
        <div class="pill">${escapeHtml(integrationLabel)}</div>
        <div class="grid">
          <div class="tile">
            <div class="label">Plugin</div>
            <div class="value">${escapeHtml(status.pluginId)}</div>
          </div>
          <div class="tile">
            <div class="label">Dashboard path</div>
            <div class="value"><code>${escapeHtml(status.dashboardPath)}</code></div>
          </div>
          <div class="tile">
            <div class="label">Upstream API</div>
            <div class="value">${escapeHtml(apiBaseUrlLabel)}</div>
          </div>
          <div class="tile">
            <div class="label">Generated</div>
            <div class="value">${escapeHtml(status.generatedAt)}</div>
          </div>
        </div>
        <div class="actions">
          <a class="button" href="${escapeHtml(`${status.dashboardPath}/status`)}">JSON status</a>
          <a class="button secondary" href="${escapeHtml(`${status.dashboardPath}/health`)}">Health probe</a>
          <a class="button secondary" href="${escapeHtml(`${status.dashboardPath}/metrics`)}">Metrics</a>
          <a class="button secondary" href="${escapeHtml(`${status.dashboardPath}/api/workflows`)}">Workflows API</a>
          <a class="button secondary" href="${escapeHtml(`${status.dashboardPath}/api/teams`)}">Teams API</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function createClawworldTeamsHttpHandler(config: ClawworldTeamsPluginConfig) {
  let runtimeAppPromise: Promise<Application> | null = null;

  async function loadRuntimeApp(): Promise<Application> {
    runtimeAppPromise ??= import("./runtime/src/index.js")
      .then(async ({ createApp }) => {
        const runtime = await createApp();
        return runtime.app;
      })
      .catch((error) => {
        runtimeAppPromise = null;
        throw error;
      });
    return runtimeAppPromise;
  }

  return async function handleClawworldTeamsRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      sendResponse(res, 405, "text/plain; charset=utf-8", "Method Not Allowed", method);
      return true;
    }

    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const requestPath = requestUrl.pathname;
    const namespacePrefix = `${config.dashboardPath}/`;
    const routeMatches =
      requestPath === config.dashboardPath || requestPath.startsWith(namespacePrefix);
    if (!routeMatches) {
      return false;
    }

    const routeSuffix =
      requestPath === config.dashboardPath ? "" : requestPath.slice(namespacePrefix.length);
    if (routeSuffix === "" || routeSuffix === "index.html") {
      const status = buildClawworldTeamsStatusSnapshot(config, requestPath);
      sendResponse(
        res,
        200,
        "text/html; charset=utf-8",
        renderClawworldTeamsDashboardHtml(status),
        method,
      );
      return true;
    }

    if (routeSuffix === "status") {
      const status = buildClawworldTeamsStatusSnapshot(config, requestPath);
      sendResponse(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify(status, null, 2),
        method,
      );
      return true;
    }

    if (routeSuffix === "health") {
      const body = JSON.stringify({
        ok: true,
        pluginId: "clawworld-teams",
        dashboardPath: config.dashboardPath,
      });
      sendResponse(res, 200, "application/json; charset=utf-8", body, method);
      return true;
    }

    if (!requestPath.startsWith(namespacePrefix)) {
      return false;
    }

    try {
      const runtimeApp = await loadRuntimeApp();
      const forwardedPath = routeSuffix.length > 0 ? `/${routeSuffix}` : "/";
      const forwardedUrl = `${forwardedPath}${requestUrl.search}`;
      (req as IncomingMessage & { url: string }).url = forwardedUrl;

      runtimeApp(req, res);
      return true;
    } catch (error) {
      const body = JSON.stringify({
        error: "ClawWorld runtime request failed",
        message: error instanceof Error ? error.message : String(error),
        path: requestPath,
      });
      sendResponse(res, 500, "application/json; charset=utf-8", body, method);
      return true;
    }
  };
}
