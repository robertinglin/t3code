import type { AgentLauncherSettings } from "@t3tools/contracts/settings";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

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
  settings: AgentLauncherSettings,
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
  AgentLauncherSettings
>()("@t3tools/provider-core/server/AgentLauncherPolicy") {}
