import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(_bb: BbPluginApi) {
  // Presentation-only plugin: provider marks live entirely in the frontend
  // bundle. The backend entry stays intentionally empty.
}
