import crypto from "node:crypto";
import { Resend } from "resend";
import type { Request, Response } from "express";
import { supabase } from "../../config/supabase.ts";
import { config } from "../../config/env.ts";
import { hashAuthToken } from "../../utils/authTokens.ts";
import { withTimeout } from "../../utils/withTimeout.ts";
import { invalidateOrganizationAnalytics } from "./organizationController.ts";

const resend = config.resendApiKey && config.resendApiKey !== "re_xxxxxxxxx"
  ? new Resend(config.resendApiKey)
  : null;
const INVITE_TTL_DAYS = 7;

function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function cleanCohort(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const cohort = value.trim();
  if (!cohort) return null;
  return cohort.length <= 80 && !/[\u0000-\u001f\u007f]/.test(cohort) ? cohort : undefined;
}

function membershipTableMissing(error: any): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205"
    || (typeof error?.message === "string"
      && error.message.includes("pitchnest_org_founder_memberships")
      && /not find|does not exist|schema cache/i.test(error.message));
}

function inviteExpiry(): string {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function publicFounderInvite(invite: any, status: "pending" | "accepted" | "revoked" | "expired" = "pending") {
  return {
    id: String(invite.id),
    email: invite.email,
    cohort: invite.cohort ?? null,
    expiresAt: invite.expires_at,
    acceptedAt: invite.accepted_at ?? null,
    revokedAt: invite.revoked_at ?? null,
    createdAt: invite.created_at,
    status,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function sendInvite(email: string, organizationName: string, inviteUrl: string, subject: string): Promise<boolean> {
  if (!resend) return false;
  try {
    const { error } = await withTimeout(resend.emails.send({
      from: config.emailFrom,
      replyTo: config.emailReplyTo,
      to: email,
      subject,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:auto;padding:32px"><h2>${escapeHtml(organizationName)} invited you to PitchNest</h2><p>Use this private link to accept the invitation. It expires in ${INVITE_TTL_DAYS} days and can be used once.</p><a href="${inviteUrl}" style="display:inline-block;margin:20px 0;padding:14px 24px;background:#4f46e5;color:white;border-radius:10px;text-decoration:none;font-weight:700">Accept invitation</a><p style="font-size:12px;color:#64748b">If you were not expecting this invitation, you can ignore this email.</p></div>`,
    }, { idempotencyKey: `organization-invite/${crypto.createHash("sha256").update(inviteUrl).digest("hex").slice(0, 40)}` }), 15_000, "Organization invitation email");
    if (!error) return true;
    console.error("Organization invitation email failed:", error.message);
  } catch (error: any) {
    console.error("Organization invitation email failed:", error?.message || error);
  }
  return false;
}

async function organizationName(orgCode: string): Promise<string> {
  const { data, error } = await supabase.from("Organizations").select("org_name")
    .eq("org_code", Number(orgCode)).maybeSingle();
  if (error) throw error;
  return data?.org_name || "Your organization";
}

export const listOrganizationTeam = async (req: Request, res: Response) => {
  const orgId = req.organization!.id;
  const { data, error } = await supabase.from("pitchnest_org_staff_accounts")
    .select("id, name, email, role, status, created_at, accepted_at, last_login_at, invite_expires_at")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("Organization team lookup failed:", error.message);
    return res.status(500).json({ error: "Could not load organization administrators." });
  }
  return res.json({ data: { members: data ?? [] } });
};

export const inviteOrganizationTeamMember = async (req: Request, res: Response) => {
  try {
    const email = cleanEmail(req.body?.email);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const role = req.body?.role;
    if (!email || name.length < 2 || name.length > 120 || !["admin", "facilitator"].includes(role)) {
      return res.status(400).json({ error: "Enter a valid name, email, and organization role." });
    }
    if (req.organization!.role === "admin" && role !== "facilitator") {
      return res.status(403).json({ error: "Only an owner can invite another administrator." });
    }
    const { data: existing, error: existingError } = await supabase.from("pitchnest_org_staff_accounts")
      .select("id, organization_id, status, auth_version")
      .eq("email", email)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing && (existing.organization_id !== req.organization!.id || existing.status === "active")) {
      return res.status(409).json({ error: "This email already has an active organization account." });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashAuthToken("organization-invite", rawToken);
    const values = {
      organization_id: req.organization!.id,
      name,
      email,
      password_hash: null,
      role,
      status: "invited",
      auth_version: (existing?.id ? Number(existing.auth_version ?? 0) + 1 : 0),
      failed_login_attempts: 0,
      locked_until: null,
      invite_token_hash: tokenHash,
      invite_expires_at: inviteExpiry(),
      invited_by: req.organization!.memberId ?? null,
      accepted_at: null,
    };
    let member: any = null;
    let error: any = null;
    if (existing?.id) {
      const updated = await supabase.from("pitchnest_org_staff_accounts").update(values)
        .eq("id", existing.id)
        .eq("auth_version", existing.auth_version ?? 0)
        .select("id, name, email, role, status, invite_expires_at")
        .maybeSingle();
      member = updated.data;
      error = updated.error;
    } else {
      const inserted = await supabase.from("pitchnest_org_staff_accounts").insert(values)
        .select("id, name, email, role, status, invite_expires_at")
        .single();
      member = inserted.data;
      error = inserted.error;
    }
    if (error || !member) throw error || new Error("Invitation could not be created");

    const orgName = await organizationName(req.organization!.orgCode);
    const inviteUrl = `${config.clientUrl}/organization-invite?token=${rawToken}`;
    const emailSent = await sendInvite(email, orgName, inviteUrl, `Join ${orgName} on PitchNest`);
    return res.status(201).json({ data: { member, inviteUrl, emailSent } });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ error: "This email already has an organization account." });
    console.error("Organization team invitation failed:", error?.message || error);
    return res.status(500).json({ error: "Could not create organization invitation." });
  }
};

export const revokeOrganizationTeamMember = async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId);
  if (!Number.isSafeInteger(memberId) || memberId <= 0) return res.status(400).json({ error: "Invalid member." });
  if (memberId === req.organization!.memberId) return res.status(400).json({ error: "You cannot revoke your own organization access." });
  const { data: target, error: lookupError } = await supabase.from("pitchnest_org_staff_accounts")
    .select("id, role, status")
    .eq("id", memberId)
    .eq("organization_id", req.organization!.id)
    .maybeSingle();
  if (lookupError) return res.status(500).json({ error: "Could not verify organization member." });
  if (!target) return res.status(404).json({ error: "Organization member not found." });
  if (target.role === "owner") return res.status(403).json({ error: "The organization owner cannot be revoked here." });
  if (req.organization!.role === "admin" && target.role !== "facilitator") {
    return res.status(403).json({ error: "Only the organization owner can revoke an administrator." });
  }
  const { data: revoked, error } = await supabase.rpc("revoke_organization_member_access", {
    p_member_id: memberId,
    p_organization_id: req.organization!.id,
  });
  if (error) return res.status(500).json({ error: "Could not revoke organization access." });
  if (revoked !== true) return res.status(409).json({ error: "Organization member access changed. Refresh and try again." });
  return res.status(204).send();
};

export const listOrganizationInvites = async (req: Request, res: Response) => {
  const { data, error } = await supabase.from("pitchnest_org_cohort_invites")
    .select("id, email, cohort, expires_at, accepted_at, revoked_at, created_at")
    .eq("organization_id", req.organization!.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("Organization cohort invites lookup failed:", error.message);
    return res.status(500).json({ error: "Could not load cohort invitations." });
  }
  const invites = (data ?? []).map((invite) => ({
    id: invite.id,
    email: invite.email,
    cohort: invite.cohort ?? null,
    expiresAt: invite.expires_at,
    acceptedAt: invite.accepted_at,
    revokedAt: invite.revoked_at,
    createdAt: invite.created_at,
    status: invite.accepted_at ? "accepted" : invite.revoked_at ? "revoked" : new Date(invite.expires_at) <= new Date() ? "expired" : "pending",
  }));
  return res.json({ data: { invites } });
};

export const createOrganizationInvite = async (req: Request, res: Response) => {
  try {
    const email = cleanEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "Enter a valid founder email address." });
    const cohort = cleanCohort(req.body?.cohort);
    if (cohort === undefined) return res.status(400).json({ error: "Cohort names must be 80 characters or fewer." });
    const orgId = req.organization!.id;
    const { data: organization, error: orgError } = await supabase.from("Organizations")
      .select("id, org_name, org_code, org_users_capacity, org_users_enrolled")
      .eq("id", orgId)
      .maybeSingle();
    if (orgError || !organization) throw orgError || new Error("Organization not found");
    const { count: pendingInvites, error: pendingError } = await supabase.from("pitchnest_org_cohort_invites")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString());
    if (pendingError) throw pendingError;
    if ((organization.org_users_enrolled ?? 0) + (pendingInvites ?? 0) >= (organization.org_users_capacity ?? 0)) {
      return res.status(409).json({ error: "All organization seats are currently assigned." });
    }
    const { data: existingUser, error: userError } = await supabase.from("users")
      .select("id, orgCode")
      .eq("email", email)
      .maybeSingle();
    if (userError) throw userError;
    if (existingUser) {
      const { data: existingMembership, error: membershipError } = await supabase.from("pitchnest_org_founder_memberships")
        .select("id")
        .eq("organization_id", orgId)
        .eq("user_id", existingUser.id)
        .eq("status", "active")
        .maybeSingle();
      if (membershipError) {
        const missingMembershipTable = membershipError.code === "42P01" || membershipError.code === "PGRST205"
          || (String(membershipError.message || "").includes("pitchnest_org_founder_memberships")
            && /not find|does not exist|schema cache/i.test(membershipError.message));
        if (!missingMembershipTable) throw membershipError;
        if (existingUser.orgCode && existingUser.orgCode === String(organization.org_code)) {
          return res.status(409).json({ error: "This founder is already in your organization." });
        }
      }
      if (existingMembership) return res.status(409).json({ error: "This founder is already in your organization." });
    }
    const { data: oldInvite, error: inviteLookupError } = await supabase.from("pitchnest_org_cohort_invites")
      .select("id")
      .eq("organization_id", orgId)
      .eq("email", email)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (inviteLookupError) throw inviteLookupError;
    if (oldInvite) return res.status(409).json({ error: "An active invitation already exists for this email." });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashAuthToken("organization-invite", rawToken);
    const { data: invite, error } = await supabase.from("pitchnest_org_cohort_invites").insert({
      organization_id: orgId,
      email,
      cohort,
      token_hash: tokenHash,
      expires_at: inviteExpiry(),
      created_by: req.organization!.memberId ?? null,
    }).select("id, email, cohort, expires_at, created_at").single();
    if (error || !invite) throw error || new Error("Invitation could not be created");
    const inviteUrl = `${config.clientUrl}/signup?organizationInvite=${rawToken}`;
    const emailSent = await sendInvite(email, organization.org_name || "Your organization", inviteUrl, `Join ${organization.org_name || "an organization"} on PitchNest`);
    return res.status(201).json({ data: { invite: publicFounderInvite(invite), inviteUrl, emailSent } });
  } catch (error: any) {
    console.error("Founder organization invitation failed:", error?.message || error);
    return res.status(500).json({ error: "Could not create the founder invitation." });
  }
};

export const createOrganizationInvitesBulk = async (req: Request, res: Response) => {
  try {
    const input = req.body?.emails;
    if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
      return res.status(400).json({ error: "Submit between 1 and 100 founder email addresses." });
    }
    const cohort = cleanCohort(req.body?.cohort);
    if (cohort === undefined) return res.status(400).json({ error: "Cohort names must be 80 characters or fewer." });

    const results: any[] = input.map((value: unknown) => ({
      email: typeof value === "string" ? value.trim() : "",
      status: "rejected",
      message: "Enter a valid founder email address.",
    }));
    const candidates: { index: number; email: string }[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < input.length; index += 1) {
      const email = cleanEmail(input[index]);
      if (!email) continue;
      results[index].email = email;
      if (seen.has(email)) {
        results[index] = { email, status: "duplicate", message: "This address appears more than once in the list." };
        continue;
      }
      seen.add(email);
      candidates.push({ index, email });
    }

    if (candidates.length) {
      const orgId = req.organization!.id;
      const { data: organization, error: orgError } = await supabase.from("Organizations")
        .select("id, org_name, org_code, org_users_capacity, org_users_enrolled")
        .eq("id", orgId).maybeSingle();
      if (orgError || !organization) throw orgError || new Error("Organization not found");

      const emails = candidates.map((item) => item.email);
      const { data: existingUsers, error: usersError } = await supabase.from("users")
        .select("id, email, orgCode").in("email", emails);
      if (usersError) throw usersError;

      const existingUserIds = (existingUsers ?? []).map((user) => user.id);
      const activeMemberUserIds = new Set<string>();
      if (existingUserIds.length) {
        const { data: memberships, error: membershipError } = await supabase.from("pitchnest_org_founder_memberships")
          .select("user_id").eq("organization_id", orgId).eq("status", "active").in("user_id", existingUserIds);
        if (membershipError && !membershipTableMissing(membershipError)) throw membershipError;
        if (!membershipError) (memberships ?? []).forEach((membership) => activeMemberUserIds.add(String(membership.user_id)));
      }

      const memberEmails = new Set((existingUsers ?? []).filter((user) =>
        activeMemberUserIds.has(String(user.id)) || String(user.orgCode ?? "") === String(organization.org_code),
      ).map((user) => String(user.email).toLowerCase()));

      const now = new Date().toISOString();
      const { data: activeInvites, error: activeInvitesError } = await supabase.from("pitchnest_org_cohort_invites")
        .select("email").eq("organization_id", orgId).in("email", emails)
        .is("accepted_at", null).is("revoked_at", null).gt("expires_at", now);
      if (activeInvitesError) throw activeInvitesError;
      const inviteEmails = new Set((activeInvites ?? []).map((invite) => invite.email.toLowerCase()));

      const { count: pendingInvites, error: pendingError } = await supabase.from("pitchnest_org_cohort_invites")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId).is("accepted_at", null).is("revoked_at", null).gt("expires_at", now);
      if (pendingError) throw pendingError;
      let seatsAvailable = Math.max(0,
        Number(organization.org_users_capacity ?? 0)
        - Number(organization.org_users_enrolled ?? 0)
        - Number(pendingInvites ?? 0));

      const toCreate: { index: number; email: string; rawToken: string }[] = [];
      for (const candidate of candidates) {
        if (memberEmails.has(candidate.email)) {
          results[candidate.index] = { email: candidate.email, status: "rejected", message: "This founder is already in your organization." };
        } else if (inviteEmails.has(candidate.email)) {
          results[candidate.index] = { email: candidate.email, status: "rejected", message: "An active invitation already exists for this email." };
        } else if (seatsAvailable <= 0) {
          results[candidate.index] = { email: candidate.email, status: "rejected", message: "No organization seats are available for this invitation." };
        } else {
          seatsAvailable -= 1;
          toCreate.push({ ...candidate, rawToken: crypto.randomBytes(32).toString("hex") });
        }
      }

      if (toCreate.length) {
        const rows = toCreate.map((item) => ({
          organization_id: orgId,
          email: item.email,
          cohort,
          token_hash: hashAuthToken("organization-invite", item.rawToken),
          expires_at: inviteExpiry(),
          created_by: req.organization!.memberId ?? null,
        }));
        const { data: inserted, error: insertError } = await supabase.from("pitchnest_org_cohort_invites")
          .insert(rows).select("id, email, cohort, expires_at, created_at");
        if (insertError) throw insertError;

        const insertedByEmail = new Map((inserted ?? []).map((invite) => [invite.email.toLowerCase(), invite]));
        for (let offset = 0; offset < toCreate.length; offset += 10) {
          const batch = toCreate.slice(offset, offset + 10);
          await Promise.all(batch.map(async (item) => {
            const invite = insertedByEmail.get(item.email);
            if (!invite) {
              results[item.index] = { email: item.email, status: "rejected", message: "The invitation could not be confirmed." };
              return;
            }
            const inviteUrl = `${config.clientUrl}/signup?organizationInvite=${item.rawToken}`;
            const emailSent = await sendInvite(item.email, organization.org_name || "Your organization", inviteUrl,
              `Join ${organization.org_name || "an organization"} on PitchNest`);
            results[item.index] = {
              email: item.email,
              status: "invited",
              invite: publicFounderInvite(invite),
              inviteUrl,
              emailSent,
            };
          }));
        }
      }
    }

    const created = results.filter((item) => item.status === "invited").length;
    return res.status(201).json({ data: { results, created } });
  } catch (error: any) {
    console.error("Bulk founder organization invitations failed:", error?.message || error);
    return res.status(500).json({ error: "Could not process the founder invitations." });
  }
};

export const updateOrganizationFounderCohort = async (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: "Invalid founder." });
  const cohort = cleanCohort(req.body?.cohort);
  if (cohort === undefined) return res.status(400).json({ error: "Cohort names must be 80 characters or fewer." });
  const { data, error } = await supabase.from("pitchnest_org_founder_memberships")
    .update({ cohort, updated_at: new Date().toISOString() })
    .eq("organization_id", req.organization!.id).eq("user_id", userId).eq("status", "active")
    .select("id").maybeSingle();
  if (error) return res.status(500).json({ error: "Could not update the founder's cohort." });
  if (!data) return res.status(404).json({ error: "Active founder membership not found." });
  invalidateOrganizationAnalytics(req.organization!.id, req.organization!.orgCode);
  return res.json({ data: { cohort } });
};

export const removeOrganizationFounder = async (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: "Invalid founder." });
  const { data, error } = await supabase.rpc("revoke_organization_founder_membership", {
    p_organization_id: req.organization!.id,
    p_user_id: userId,
  });
  if (error) return res.status(500).json({ error: "Could not remove this founder from the organization." });
  if (data !== true) return res.status(404).json({ error: "Active founder membership not found." });
  invalidateOrganizationAnalytics(req.organization!.id, req.organization!.orgCode);
  return res.status(204).send();
};

export const updateOrganizationSettings = async (req: Request, res: Response) => {
  const orgName = typeof req.body?.orgName === "string" ? req.body.orgName.trim() : "";
  const country = typeof req.body?.country === "string" ? req.body.country.trim() : "";
  const websiteInput = typeof req.body?.websiteUrl === "string" ? req.body.websiteUrl.trim() : "";
  if (orgName.length < 2 || orgName.length > 120) {
    return res.status(400).json({ error: "Organization name must be between 2 and 120 characters." });
  }
  if (country.length > 100) return res.status(400).json({ error: "Country must be 100 characters or fewer." });
  let websiteUrl: string | null = null;
  if (websiteInput) {
    try {
      const parsed = new URL(websiteInput);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || websiteInput.length > 2048) throw new Error("invalid");
      websiteUrl = parsed.toString();
    } catch {
      return res.status(400).json({ error: "Enter a website address beginning with https:// or http://." });
    }
  }
  const { data, error } = await supabase.from("Organizations").update({
    org_name: orgName,
    country: country || null,
    website_url: websiteUrl,
  }).eq("id", req.organization!.id)
    .select("id, org_code, org_name, country, website_url")
    .maybeSingle();
  if (error) return res.status(500).json({ error: "Could not save organization settings." });
  if (!data) return res.status(404).json({ error: "Organization not found." });
  return res.json({ data: {
    id: String(data.id),
    orgCode: data.org_code,
    orgName: data.org_name,
    country: data.country ?? "",
    websiteUrl: data.website_url ?? "",
  } });
};

export const deleteOrganizationAccount = async (req: Request, res: Response) => {
  const objectPaths: string[] = [];
  for (let from = 0; ; from += 1_000) {
    const { data: files, error: fileLookupError } = await supabase.from("pitchnest_org_submission_files")
      .select("object_path").eq("organization_id", req.organization!.id).range(from, from + 999);
    if (fileLookupError) return res.status(500).json({ error: "Could not prepare organization file deletion." });
    objectPaths.push(...(files ?? []).map((file) => file.object_path).filter((path): path is string => typeof path === "string"));
    if ((files ?? []).length < 1_000) break;
  }
  for (let offset = 0; offset < objectPaths.length; offset += 100) {
    const { error: storageError } = await supabase.storage.from(config.storageBucket).remove(objectPaths.slice(offset, offset + 100));
    if (storageError) {
      console.error("Organization file cleanup failed:", storageError.message);
      return res.status(500).json({ error: "Could not remove organization files. The organization was not deleted." });
    }
  }
  const { data, error } = await supabase.rpc("delete_organization_account", {
    p_organization_id: req.organization!.id,
  });
  if (error) {
    console.error("Organization account deletion failed:", error.message);
    return res.status(500).json({ error: "Could not delete this organization." });
  }
  if (data !== true) return res.status(404).json({ error: "Organization not found." });
  invalidateOrganizationAnalytics(req.organization!.id, req.organization!.orgCode);
  return res.status(204).send();
};

export const revokeOrganizationInvite = async (req: Request, res: Response) => {
  const { data, error } = await supabase.from("pitchnest_org_cohort_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", req.params.inviteId)
    .eq("organization_id", req.organization!.id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: "Could not revoke this invitation." });
  if (!data) return res.status(404).json({ error: "Pending invitation not found." });
  return res.status(204).send();
};
