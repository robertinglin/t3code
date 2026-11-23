import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const pxpipeStats = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:pxpipe:stats",
  tag: WS_METHODS.serverGetPxpipeStats,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});
