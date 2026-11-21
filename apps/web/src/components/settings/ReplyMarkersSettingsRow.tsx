import { Switch } from "../ui/switch";
import {
  messageClickOpensThread,
  replyMarkersEnabled,
  setMessageClickOpensThread,
  setReplyMarkersEnabled,
} from "../chat/exchangeThread.logic";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ReplyMarkersSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const searchableSetting = useSearchableSetting();
  const enabled = replyMarkersEnabled(settings);
  const setEnabled = (next: boolean) =>
    updateSettings({ threadDetailsItems: setReplyMarkersEnabled(settings, next) });
  return (
    <SettingsRow
      {...searchableSetting("reply-markers")}
      description="When a reply lands below a later message, quote the message it answers above it, and show “1 reply” under that message. Select either to see the exchange on its own."
      resetAction={
        enabled ? null : (
          <SettingResetButton ariaLabel="Reset reply markers" onClick={() => setEnabled(true)} />
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

export function MessageClickThreadSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const searchableSetting = useSearchableSetting();
  const enabled = messageClickOpensThread(settings);
  const setEnabled = (next: boolean) =>
    updateSettings({ threadDetailsItems: setMessageClickOpensThread(settings, next) });
  return (
    <SettingsRow
      {...searchableSetting("message-click-thread")}
      description="Open a message’s thread when you click it. Without this, use View thread under the message, or right-click it."
      resetAction={
        enabled ? (
          <SettingResetButton
            ariaLabel="Reset open thread on message click"
            onClick={() => setEnabled(false)}
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(Boolean(checked))}
          aria-label="Open thread on message click"
        />
      }
    />
  );
}
