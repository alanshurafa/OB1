import type { ExtensionManifest } from "@/lib/extensions/types";
import { LivingProfileIcon } from "./icon";

/**
 * Living Profile extension manifest — Omi-Memories-style view over the
 * `profile_fact` thought stream and the `profile` / `profile-restricted`
 * wiki pages. See ./README.md in this recipe's dashboard-snippets folder.
 */
export const manifest: ExtensionManifest = {
  slug: "living-profile",
  label: "Profile",
  description: "Living profile — facts distilled from your brain, with citations.",
  version: "1.0.0",
  category: "extension",
  order: 30,
  icon: LivingProfileIcon,
  permissions: {
    readThoughts: true,
  },
};
