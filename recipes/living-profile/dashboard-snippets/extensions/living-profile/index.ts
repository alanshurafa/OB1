import type { Extension } from "@/lib/extensions/types";
import { manifest } from "./manifest";
import { LivingProfilePage } from "./page";

/**
 * Living Profile extension — Omi-Memories-style view over the `profile_fact`
 * thought stream and the `profile` / `profile-restricted` wiki pages written
 * by `../scripts/synthesize-profile.mjs`. See ./README.md.
 */
const extension: Extension = {
  manifest,
  Page: LivingProfilePage,
};

export default extension;
