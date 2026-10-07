import { profileStore } from "@/stores/profile";
import { CampaignType } from "scnexus-standard/metadata";

import { isGameRootValid } from "./platform";

export function getProfileStoreCampaignTypeRoot(
  type: CampaignType
): string | undefined {
  const campaignPaths = profileStore.get("PROFILE_CAMPAIGN");
  const campaignTypeRoot = campaignPaths[`${type}_ROOT`] as string | undefined;
  return campaignTypeRoot ?? undefined;
}

export async function checkGameRootValid(gameRoot: string): Promise<boolean> {
  console.log("checkGameRootValid", gameRoot);
  return await isGameRootValid(gameRoot);
}
