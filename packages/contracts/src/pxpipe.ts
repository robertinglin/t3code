import { ANTIGRAVITY_DEFAULT_MODEL } from "./model.ts";

export const isModelRoutedLauncherProvider = (driver: string): boolean => driver === "antigravity";

export const defaultAgentLauncher = (
  driver: string,
  config: unknown,
): "pxpipe" | "model-aware" | undefined => {
  if (isModelRoutedLauncherProvider(driver)) return "model-aware";
  if (driver !== "acpRegistry" || config === null || typeof config !== "object") {
    return undefined;
  }
  return "agentId" in config &&
    typeof config.agentId === "string" &&
    config.agentId.toLowerCase() === "gemini"
    ? "pxpipe"
    : undefined;
};

export const isPxpipeDefaultProvider = (driver: string, config: unknown): boolean =>
  defaultAgentLauncher(driver, config) === "pxpipe";

export const isGoogleModel = (model: string): boolean => {
  const normalized = model.toLowerCase();
  return (
    normalized === ANTIGRAVITY_DEFAULT_MODEL ||
    normalized.startsWith("gemini-") ||
    normalized.startsWith("google/")
  );
};
