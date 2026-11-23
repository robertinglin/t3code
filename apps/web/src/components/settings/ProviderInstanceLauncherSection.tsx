import { BILI_AGENT_COMPATIBILITY, biliAgentIdForDriver } from "@t3tools/contracts/settings";
import { isPxpipeDefaultProvider } from "@t3tools/contracts/pxpipe";
import type { ProviderInstanceConfig } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ProviderInstanceLauncherSection({
  instance,
  defaultAgentLauncher,
  readOnly,
  canWriteSettings,
  onUpdate,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly defaultAgentLauncher: "native" | "bili";
  readonly readOnly: boolean;
  readonly canWriteSettings: boolean;
  readonly onUpdate: (instance: ProviderInstanceConfig) => void;
}) {
  const gt = useGT();
  const providerConfig = instance.config;
  const registryAgentId =
    instance.driver === "acpRegistry" &&
    typeof providerConfig === "object" &&
    providerConfig !== null &&
    "agentId" in providerConfig &&
    typeof providerConfig.agentId === "string"
      ? providerConfig.agentId.toLowerCase()
      : undefined;
  const providerId = registryAgentId ?? biliAgentIdForDriver(instance.driver);
  const pxpipeDefault = isPxpipeDefaultProvider(instance.driver, providerConfig);
  const biliCompatible = BILI_AGENT_COMPATIBILITY.some(
    (entry) => entry.id === providerId && entry.supported,
  );
  if (!biliCompatible && !pxpipeDefault) return null;
  const defaultLauncher = pxpipeDefault ? "pxpipe" : defaultAgentLauncher;

  return (
    <SettingsSection title={gt("Agent launcher")}>
      <SettingsRow
        title={gt("Launcher")}
        description={gt(
          "Choose how this provider starts. Gemini CLI and Antigravity use pxpipe by default; the pxpipe proxy must be running.",
        )}
        control={
          <Select
            value={instance.agentLauncher ?? (pxpipeDefault ? "pxpipe" : "default")}
            onValueChange={(value) => {
              if (value === "default") {
                const { agentLauncher: _omit, ...rest } = instance;
                onUpdate(rest);
              } else if (
                value === "native" ||
                (value === "bili" && biliCompatible) ||
                (value === "pxpipe" && pxpipeDefault)
              ) {
                onUpdate({ ...instance, agentLauncher: value });
              }
            }}
            disabled={readOnly || !canWriteSettings}
          >
            <SelectTrigger size="sm" className="w-full sm:w-52" aria-label={gt("Agent launcher")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="default">
                {gt("Default ({launcher})", {
                  launcher:
                    defaultLauncher === "pxpipe"
                      ? "pxpipe"
                      : defaultLauncher === "bili"
                        ? "bili"
                        : gt("Native"),
                })}
              </SelectItem>
              <SelectItem hideIndicator value="native">
                <T>Native</T>
              </SelectItem>
              {biliCompatible ? (
                <SelectItem hideIndicator value="bili">
                  <T>Billion Context (bili)</T>
                </SelectItem>
              ) : null}
              {pxpipeDefault ? (
                <SelectItem hideIndicator value="pxpipe">
                  <T>pxpipe</T>
                </SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
