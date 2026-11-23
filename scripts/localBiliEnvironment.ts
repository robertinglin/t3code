// @effect-diagnostics nodeBuiltinImport:off - this deploy helper runs before Effect services exist.
import * as NodePath from "node:path";

export function standaloneBiliEnvironment(env: NodeJS.ProcessEnv, home: string) {
  const configHome = env.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  const dataHome = env.XDG_DATA_HOME?.trim() || NodePath.join(home, ".local", "share");

  return {
    BILI_CONFIG_FILE:
      env.BILI_CONFIG_FILE?.trim() ||
      NodePath.join(configHome, "billion-context", "billion-context.json"),
    BILI_SESSIONS_DIR:
      env.BILI_SESSIONS_DIR?.trim() || NodePath.join(dataHome, "billion-context", "sessions"),
  };
}
