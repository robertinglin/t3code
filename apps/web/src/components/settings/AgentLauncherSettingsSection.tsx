import { BILI_AGENT_COMPATIBILITY } from "@t3tools/contracts/settings";
import { msg, useGT, useMessages } from "gt-react";

import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const BILI_COMPATIBILITY_COPY = {
  codex: { label: msg("Codex") },
  claude: { label: msg("Claude Code") },
  cline: { label: msg("Cline") },
  "glm-acp-agent": { label: msg("GLM ACP Agent") },
  antigravity: { label: msg("Antigravity") },
  opencode: { label: msg("OpenCode") },
  pi: { label: msg("Pi") },
  kiro: {
    label: msg("Kiro"),
    reason: msg("The installed bili command does not list a Kiro launcher."),
  },
  cursor: {
    label: msg("Cursor"),
    reason: msg("T3 connects through Cursor's SDK and does not launch a local Cursor CLI."),
  },
  grok: {
    label: msg("Grok"),
    reason: msg("The installed bili command does not list a Grok launcher."),
  },
  muse: {
    label: msg("Muse Code"),
    reason: msg("The installed bili command does not list a Muse launcher."),
  },
  fx: {
    label: msg("fx"),
    reason: msg("The installed bili command does not list an fx launcher."),
  },
};

export function AgentLauncherSettingsSection() {
  const gt = useGT();
  const messages = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsSection id="agent-launcher" title={gt("Agent launcher")}>
      <SettingsRow
        serverScoped
        settingKeys={["agentLauncher"]}
        title={gt("Agent launcher")}
        description={gt(
          "Choose whether coding agents start directly or through Billion Context (bili).",
        )}
        control={
          <Select
            value={settings.agentLauncher.launcher}
            onValueChange={(value) => {
              if (value === "native" || value === "bili") {
                updateSettings({
                  agentLauncher: { ...settings.agentLauncher, launcher: value },
                });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={gt("Agent launcher")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="native">
                {gt("Native")}
              </SelectItem>
              <SelectItem hideIndicator value="bili">
                {gt("Billion Context (bili)")}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {settings.agentLauncher.launcher === "bili" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["agentLauncher"]}
            title={gt("Bili executable path")}
            description={gt("Leave blank to find bili on PATH.")}
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={settings.agentLauncher.biliBinaryPath}
                placeholder="bili"
                spellCheck={false}
                aria-label={gt("Bili executable path")}
                onCommit={(biliBinaryPath) =>
                  updateSettings({
                    agentLauncher: {
                      ...settings.agentLauncher,
                      biliBinaryPath: biliBinaryPath.trim(),
                    },
                  })
                }
              />
            }
          />
          <SettingsRow
            title={gt("Compatibility status")}
            description={
              <>
                <div>
                  {gt("Supported")}:{" "}
                  {BILI_AGENT_COMPATIBILITY.filter((entry) => entry.supported)
                    .map((entry) => messages(BILI_COMPATIBILITY_COPY[entry.id].label))
                    .join(", ")}
                </div>
                {BILI_AGENT_COMPATIBILITY.filter((entry) => !entry.supported).map((entry) => {
                  const copy = BILI_COMPATIBILITY_COPY[entry.id];
                  return (
                    <div key={entry.id}>
                      {messages(copy.label)}: {copy.reason ? messages(copy.reason) : ""}
                    </div>
                  );
                })}
                <div>
                  {gt(
                    "ACP Registry can use the Codex, Claude, Antigravity, OpenCode, Pi, and OMP bili launchers. Other registry IDs and custom executables are unavailable in bili mode.",
                  )}
                </div>
              </>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
