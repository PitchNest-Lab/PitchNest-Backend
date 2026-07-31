import { config } from "../config/env.ts";

/**
 * Returns a fully qualified, domain-aligned URL for an email asset.
 * Guarantees that images embedded in HTML emails are hosted on your primary domain.
 */
export function getEmailAssetUrl(assetName: string): string {
  const baseUrl = (process.env.CLIENT_URL || config.allowedOrigin || "https://pitchnest.app").replace(/\/+$/, "");
  const cleanName = assetName.startsWith("/") ? assetName : `/${assetName}`;
  return `${baseUrl}/email-assets${cleanName}`;
}

export const EMAIL_ASSETS = {
  FACEBOOK: getEmailAssetUrl("facebook-new.png"),
  INSTAGRAM: getEmailAssetUrl("instagram-new.png"),
  LINKEDIN: getEmailAssetUrl("linkedin.png"),
  X_TWITTER: getEmailAssetUrl("download.png"),
  LOGO: getEmailAssetUrl("logo.png"),
};
