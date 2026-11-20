import { BILI_AGENT_COMPATIBILITY, biliAgentIdForDriver } from "@t3tools/contracts/settings";
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
  const biliCompatible = BILI_AGENT_COMPATIBILITY.some(
    (entry) => entry.id === providerId && entry.supported,
  );
  if (!biliCompatible) return null;

  return (
    <SettingsSection title={gt("Agent launcher")}>
      <SettingsRow
        title={gt("Launcher")}
        description={gt(
          "Choose how this provider starts. The server default follows the Agent launcher setting.",
        )}
        control={
          <Select
            value={instance.agentLauncher ?? "default"}
            onValueChange={(value) => {
              if (value === "default") {
                const { agentLauncher: _omit, ...rest } = instance;
                onUpdate(rest);
              } else if (value === "native" || value === "bili") {
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
                {gt("Server default ({launcher})", {
                  launcher: defaultAgentLauncher === "bili" ? "bili" : gt("Native"),
                })}
              </SelectItem>
              <SelectItem hideIndicator value="native">
                <T>Native</T>
              </SelectItem>
              <SelectItem hideIndicator value="bili">
                <T>Billion Context (bili)</T>
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
