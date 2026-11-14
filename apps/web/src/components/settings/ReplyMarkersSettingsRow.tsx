import { Switch } from "../ui/switch";
import { replyMarkersEnabled, setReplyMarkersEnabled } from "../chat/exchangeThread.logic";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ReplyMarkersSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const enabled = replyMarkersEnabled(settings);
  const setEnabled = (next: boolean) =>
    updateSettings({ threadDetailsItems: setReplyMarkersEnabled(settings, next) });
  return (
    <SettingsRow
      {...searchableSetting("reply-markers")}
      description="When a reply lands below a later message, quote the message it answers above it, and show “1 reply” under that message. Select either to see the exchange on its own."
      resetAction={
        enabled ? null : (
          <SettingResetButton label="reply markers" onClick={() => setEnabled(true)} />
        )
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(Boolean(checked))}
          aria-label="Reply markers"
        />
      }
    />
  );
}
