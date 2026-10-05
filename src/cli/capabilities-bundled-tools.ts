import type { Capability } from "./capability-types";

export const BUNDLED_TOOL_CAPABILITIES: readonly Capability[] = [
  {
    command: ["rtk"],
    summary: "Run bundled RTK with unchanged arguments, stdio and exit status.",
    routes: [],
    flags: [],
    mutates: true,
    json: "none",
    details: [
      "RTK is included in the OpenCodex package; the command never downloads an executable or searches PATH.",
      "The delegated command can mutate files or repositories. OpenCodex does not configure global agent hooks automatically.",
      "Use ocx rtk --help for RTK's own flags and commands, or ocx rtk git status to filter Git output.",
    ],
  },
  {
    command: ["headroom", "status"],
    summary: "Read the optional Headroom sidecar status and savings ledger.",
    routes: [{ method: "GET", path: "/api/headroom" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the status JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["headroom", "stats"],
    summary: "Read Headroom's current sidecar statistics.",
    routes: [{ method: "GET", path: "/api/headroom/stats" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the statistics JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["headroom", "config"],
    summary: "Read or explicitly change Headroom settings; no flags means read only.",
    routes: [{ method: "GET", path: "/api/headroom" }, { method: "PUT", path: "/api/headroom" }],
    flags: [
      { name: "--enabled", value: "string", summary: "Enable or disable compression: true or false." },
      { name: "--base-url", value: "string", summary: "Set the operator's Headroom sidecar URL." },
      { name: "--json", value: "boolean", summary: "Emit the resulting status JSON." },
    ],
    mutates: true,
    json: "payload",
  },
];
