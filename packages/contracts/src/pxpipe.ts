export const isPxpipeDefaultProvider = (driver: string, config: unknown): boolean => {
  if (driver === "antigravity") return true;
  if (driver !== "acpRegistry" || config === null || typeof config !== "object") return false;
  return (
    "agentId" in config &&
    typeof config.agentId === "string" &&
    config.agentId.toLowerCase() === "gemini"
  );
};
