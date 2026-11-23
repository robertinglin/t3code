import type { AgentLauncherSettings } from "@t3tools/contracts/settings";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { resolvePxpipeLaunch } from "./pxpipeLauncher.ts";

export type AgentLauncherPolicySettings = Omit<AgentLauncherSettings, "launcher"> & {
  readonly launcher: AgentLauncherSettings["launcher"] | "pxpipe";
};

export class AgentLaunchUnsupportedError extends Schema.TaggedError<AgentLaunchUnsupportedError>()(
  "AgentLaunchUnsupportedError",
  { message: Schema.String },
) {}

export interface AgentLaunchRequest {
  readonly agent: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly biliOptions?: ReadonlyArray<string>;
  readonly biliEnvironment?: NodeJS.ProcessEnv;
  readonly biliCompatibility?:
    | { readonly supported: true }
    | { readonly supported: false; readonly reason: string };
}

export interface ResolvedAgentLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type AgentLaunchResolution =
  | { readonly _tag: "Resolved"; readonly launch: ResolvedAgentLaunch }
  | { readonly _tag: "Unsupported"; readonly message: string };

export function resolveAgentLaunch(
  request: AgentLaunchRequest,
  settings: AgentLauncherPolicySettings,
): AgentLaunchResolution {
  if (settings.launcher === "native") {
    return {
      _tag: "Resolved",
      launch: {
        command: request.executable,
        args: request.args,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
      },
    };
  }

  if (settings.launcher === "pxpipe") {
    return { _tag: "Resolved", launch: resolvePxpipeLaunch(request) };
  }

  if (request.biliCompatibility?.supported !== true) {
    return {
      _tag: "Unsupported",
      message: `${request.agent} cannot be launched through bili: ${request.biliCompatibility?.reason ?? "This launch has not been verified for bili."}`,
    };
  }

  return {
    _tag: "Resolved",
    launch: {
      command: settings.biliBinaryPath.trim() || "bili",
      args: [
        ...(request.biliOptions ?? []),
        "--bin",
        request.executable,
        request.agent,
        ...request.args,
      ],
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: {
        ...request.env,
        ...request.biliEnvironment,
      },
    },
  };
}

export class AgentLauncherPolicy extends Context.Service<
  AgentLauncherPolicy,
  AgentLauncherPolicySettings
>()("@t3tools/provider-core/server/AgentLauncherPolicy") {}
