import type { AgentLaunchRequest, ResolvedAgentLaunch } from "./AgentLauncherPolicy.ts";

export function resolvePxpipeLaunch(request: AgentLaunchRequest): ResolvedAgentLaunch {
  return {
    command: "pxpipe",
    args: ["warp", "--", request.executable, ...request.args],
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
  };
}
