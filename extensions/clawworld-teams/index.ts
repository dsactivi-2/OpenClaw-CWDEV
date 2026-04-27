import { z } from "zod";
import { buildPluginConfigSchema, definePluginEntry, jsonResult } from "./api.js";
import {
  buildClawworldTeamsStatusSnapshot,
  createClawworldTeamsHttpHandler,
  resolveClawworldTeamsPluginConfig,
} from "./runtime-api.js";

const clawworldTeamsConfigSchema = buildPluginConfigSchema(
  z
    .object({
      dashboardPath: z.string().min(1).optional(),
      dashboardTitle: z.string().min(1).optional(),
      apiBaseUrl: z.string().optional(),
      brandLabel: z.string().min(1).optional(),
    })
    .strict(),
  {
    uiHints: {
      dashboardPath: { label: "Dashboard path", placeholder: "/clawworld" },
      dashboardTitle: { label: "Dashboard title", placeholder: "ClawWorld Control" },
      apiBaseUrl: { label: "API base URL", placeholder: "https://api.example.com" },
      brandLabel: { label: "Brand label", placeholder: "ClawWorld Teams" },
    },
  },
);

export default definePluginEntry({
  id: "clawworld-teams",
  name: "ClawWorld Teams",
  description: "ClawWorld dashboard and Teams integration bridge for OpenClaw.",
  configSchema: clawworldTeamsConfigSchema,
  register(api) {
    const config = resolveClawworldTeamsPluginConfig(api.pluginConfig);

    api.registerTool({
      name: "clawworld_status",
      label: "ClawWorld Status",
      description: "Inspect the bundled ClawWorld Teams bridge status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const status = buildClawworldTeamsStatusSnapshot(config);
        return jsonResult(status);
      },
    });

    api.registerHttpRoute({
      path: config.dashboardPath,
      auth: "gateway",
      match: "prefix",
      replaceExisting: true,
      handler: createClawworldTeamsHttpHandler(config),
    });
  },
});
