import { supabase } from "../config/supabase.ts";

/**
 * The region of the business a session is about, used only to pick a speech
 * recognition locale for founders who have not chosen one (see inferSttLocale).
 *
 * Prefers the business the session is linked to; otherwise the founder's most
 * recently updated active business. Reads the `region` column and nothing else.
 * Never throws: on any failure the session simply uses the default locale.
 */
export async function lookupBusinessRegion(
  userId: number | null,
  linkedBusinessId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const regionOf = (row: any): string | null =>
    typeof row?.region === "string" && row.region.trim() ? row.region : null;

  try {
    if (linkedBusinessId) {
      const { data } = await supabase
        .from("businesses")
        .select("region")
        .eq("id", linkedBusinessId)
        .maybeSingle();
      const region = regionOf(data);
      if (region) return region;
    }

    const { data: memberships } = await supabase
      .from("business_members")
      .select("business_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(10);
    const ids = (memberships ?? []).map((m: any) => m.business_id).filter(Boolean);
    if (ids.length === 0) return null;

    const { data: businesses } = await supabase
      .from("businesses")
      .select("region")
      .in("id", ids)
      .neq("status", "removed")
      .order("updated_at", { ascending: false })
      .limit(10);
    for (const row of businesses ?? []) {
      const region = regionOf(row);
      if (region) return region;
    }
    return null;
  } catch {
    return null;
  }
}
