// fork: rows the fork adds to upstream's Tools > Stream section, rendered there
// by a single `fork:` seam. They hold their own state, so nothing is threaded
// through ToolsPanel or client.tsx.

import { Scaling } from "lucide-react";
import { SettingRow } from "../components/simulator-settings-tool";
import { SettingSwitch } from "../components/setting-switch";
import { useResizeHandleHidden } from "./viewer";

export function ForkStreamSettings() {
  const [hidden, setHidden] = useResizeHandleHidden();
  return (
    <SettingRow icon={<Scaling size={14} strokeWidth={2} />} label="Resize handle">
      <SettingSwitch label="Resize handle" checked={!hidden} onChange={(show) => setHidden(!show)} />
    </SettingRow>
  );
}
