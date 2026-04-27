import { describe, expect, it } from "vitest";
import { createClawworldTeamsHttpHandler } from "./runtime-api.js";
import {
  buildClawworldTeamsStatusSnapshot,
  renderClawworldTeamsDashboardHtml,
  resolveClawworldTeamsPluginConfig,
} from "./runtime-api.js";

describe("clawworld-teams runtime helpers", () => {
  it("normalizes plugin config and renders safe dashboard html", () => {
    const config = resolveClawworldTeamsPluginConfig({
      dashboardPath: "plugins/clawworld-teams/",
      dashboardTitle: "ClawWorld <Control>",
      apiBaseUrl: "https://api.example.com/",
      brandLabel: "ClawWorld & Teams",
    });

    expect(config.dashboardPath).toBe("/plugins/clawworld-teams");
    expect(config.dashboardTitle).toBe("ClawWorld <Control>");
    expect(config.apiBaseUrl).toBe("https://api.example.com/");

    const status = buildClawworldTeamsStatusSnapshot(config, "/plugins/clawworld-teams");
    const html = renderClawworldTeamsDashboardHtml(status);

    expect(html).toContain("ClawWorld &amp; Teams");
    expect(html).toContain("ClawWorld &lt;Control&gt;");
    expect(html).toContain("/plugins/clawworld-teams/status");
  });

  it("serves the bundled dashboard root without booting the runtime app", async () => {
    const handler = createClawworldTeamsHttpHandler(
      resolveClawworldTeamsPluginConfig({
        dashboardPath: "/clawworld",
      }),
    );
    const response = createResponseRecorder();

    const handled = await handler(
      {
        method: "GET",
        url: "/clawworld",
      } as never,
      response as never,
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("ClawWorld Control");
    expect(response.body).toContain("/clawworld/status");
  });
});

function createResponseRecorder() {
  const headers: Record<string, string> = {};
  const recorder = {
    statusCode: 0,
    headers,
    body: "",
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      if (typeof body === "string") {
        recorder.body = body;
      }
    },
  };
  return recorder;
}
