// Haly: a local build of the Haly integration branch, installed from a packed tarball.
// The published @bitkyc08/opencodex package would replace it and silently drop the Haly
// extensions, so every self-update entrypoint refuses while the install marker is present.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Written into the installed package root by the local install procedure (see HALY.md). */
export const HALY_LOCAL_BUILD_MARKER = ".haly-local-build";

export const HALY_LOCAL_BUILD_UPDATE_REFUSAL =
  "this is a local Haly build of OpenCodex (Haly extensions and bundled RTK). "
  + "Updating would install the published package and drop them. Merge the new OpenCodex "
  + "release into the haly-sync branch and reinstall it (see HALY.md), or set "
  + "OCX_ALLOW_UPSTREAM_UPDATE=1 to replace it with the published package anyway.";

/** True when `packageRoot` is a marked local Haly install and no explicit override is set. */
export function isHalyLocalBuild(packageRoot, env = process.env) {
  if (env.OCX_ALLOW_UPSTREAM_UPDATE === "1") return false;
  try {
    return existsSync(join(packageRoot, HALY_LOCAL_BUILD_MARKER));
  } catch {
    return false;
  }
}
