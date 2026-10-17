import { Request, Response } from "express";
import { supabase } from "../../config/supabase.ts";
import { config } from "../../config/env.ts";
import { safeAvatarUrl } from "../../utils/storagePath.ts";
import {
  pitchScoreFromReport,
  isCompletePitch,
  readinessFromReport,
  panelTypeLabel,
  pitchStatusFromSession,
} from "../../utils/scoring.ts";

const ANALYTICS_CACHE_MS = 20_000;
const MAX_ANALYTICS_CACHE_ENTRIES = 25;
const DATABASE_PAGE_SIZE = 1_000;
const MAX_ANALYTICS_ROWS = 25_000;
const analyticsCache = new Map<string, { expiresAt: number; value: Promise<any[]> }>();

async function cachedRows(key: string, load: () => Promise<any[]>): Promise<any[]> {
  const now = Date.now();
  const existing = analyticsCache.get(key);
  if (existing && existing.expiresAt > now) return existing.value;
  if (analyticsCache.size >= MAX_ANALYTICS_CACHE_ENTRIES) {
    const oldest = analyticsCache.keys().next().value;
    if (oldest) analyticsCache.delete(oldest);
  }
  const value = load().catch((error) => {
    analyticsCache.delete(key);
    throw error;
  });
  analyticsCache.set(key, { expiresAt: now + ANALYTICS_CACHE_MS, value });
  return value;
}

async function loadAllPages(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; from < MAX_ANALYTICS_ROWS; from += DATABASE_PAGE_SIZE) {
    const { data, error } = await makeQuery(from, from + DATABASE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < DATABASE_PAGE_SIZE) return rows;
  }
  throw new Error(`Organization analytics exceeded the ${MAX_ANALYTICS_ROWS}-row safety limit.`);
}

const getOrgUsers = async (orgId: string) => cachedRows(`users:${orgId}`, async () => {
  return loadAllPages((from, to) => supabase
      .from("users")
      .select("id, name, email, avatar_url, role, cohort, enrolled_at, created_at, last_active")
      .eq("orgCode", orgId)
      .order("id", { ascending: true })
      .range(from, to));
});

const getOrgSessions = async (orgId: string, userIds: (string | number)[]) => {
  if (!userIds.length) return [];
  return cachedRows(`sessions:${orgId}`, async () => {
    const memberIds = new Set(userIds.map(String));
    const sessions = await loadAllPages((from, to) => supabase
        // The view removes evaluation_report.transcript inside PostgreSQL, so
        // organization analytics never transfer or cache founder transcripts.
        .from("session_list_safe")
        .select("id, user_id, created_at, timestamp, evaluation_report, business_name, mode, pitch_config, summary")
        .eq("org_id", orgId)
        .eq("visibility", "organization")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to));
    return sessions.filter((session: any) => memberIds.has(String(session.user_id))).map((session: any) => {
      const report = session.evaluation_report && typeof session.evaluation_report === "object"
        ? session.evaluation_report
        : {};
      return { ...session, evaluation_report: report };
    });
  });
};

// Your real org table is "Organizations" (plural), keyed by org_code, with a
// "plan" column (not "plan_name") and no renewal_date — "validity" instead.
const getOrg = async (orgId: string) => {
  const { data: org, error } = await supabase
    .from("Organizations")
    .select("id, created_at, org_code, org_name, org_users_capacity, org_users_enrolled, validity, plan, email, country, website_url, trial_started_at, trial_expires_at, trial_status")
    .eq("org_code", Number(orgId))
    .maybeSingle();
  if (error) throw error;
  return org;
};

/* ---------------- ORGANIZATION DETAILS (full profile + QR link) ---------------- */
export const orgDetails = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const org = await getOrg(orgId);

    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    const baseUrl = config.appBaseUrl.replace(/\/+$/, "");

    res.status(200).json({
      data: {
        id: String(org.id),
        orgCode: org.org_code,
        orgName: org.org_name ?? "Organization",
        capacity: org.org_users_capacity ?? 0,
        enrolled: org.org_users_enrolled ?? 0,
        validity: org.validity,
        plan: org.plan ?? "—",
        email: org.email,
        country: org.country ?? "—",
        websiteUrl: org.website_url ?? "",
        trialStartedAt: org.trial_started_at ?? null,
        trialExpiresAt: org.trial_expires_at ?? null,
        trialStatus: org.trial_status ?? "Active",
        createdAt: org.created_at,
        // The link the QR code encodes and the text shown underneath it.
        enrollLink: `${baseUrl}/signup?referralCode=${encodeURIComponent(String(org.org_code))}`,
      },
      message: "Organization details fetched successfully",
    });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Organization detail fetching failed" });
  }
};

/* ---------------- OVERVIEW ---------------- */
export const overview = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const org = await getOrg(orgId);

    const users = await getOrgUsers(orgId);
    const sessions = await getOrgSessions(orgId, users.map((u) => u.id));

    const totalPitches = sessions.length;
    const scored = sessions
      .map((s) => pitchScoreFromReport(s.evaluation_report))
      .filter((v): v is number => v !== null);
    const avgPitchScore = scored.length
      ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
      : 0;

    const readinessVals = sessions
      .map((s) => readinessFromReport(s.evaluation_report))
      .filter((v): v is number => v !== null);
    const avgReadinessScore = readinessVals.length
      ? Math.round(readinessVals.reduce((a, b) => a + b, 0) / readinessVals.length)
      : 0;

    const completed = sessions.filter(isCompletePitch).length;
    const completionRate = totalPitches ? Math.round((completed / totalPitches) * 100) : 0;

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const activeFoundersThisWeek = new Set(
      sessions.filter((s) => new Date(s.created_at).getTime() >= weekAgo).map((s) => s.user_id)
    ).size;

    const byUser: Record<string, number[]> = {};
    [...sessions].reverse().forEach((s) => {
      const score = pitchScoreFromReport(s.evaluation_report);
      if (score === null) return;
      (byUser[String(s.user_id)] ||= []).push(score);
    });
    const improvements = Object.values(byUser)
      .filter((arr) => arr.length >= 2)
      .map((arr) => arr[arr.length - 1] - arr[0]);
    const avgScoreImprovement = improvements.length
      ? Math.round(improvements.reduce((a, b) => a + b, 0) / improvements.length)
      : 0;

    res.status(200).json({
      data: {
        orgName: org?.org_name ?? "Organization",
        planName: org?.plan ?? "—",
        renewalDate: org?.validity ?? null,
        totalMembers: users.length,
        totalSeats: org?.org_users_capacity ?? 0,
        usedSeats: org?.org_users_enrolled ?? users.filter((u) => u.enrolled_at).length,
        totalPitches,
        avgPitchScore,
        activeFoundersThisWeek,
        avgReadinessScore,
        completionRate,
        avgScoreImprovement,
      },
      message: "Overview fetched successfully",
    });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Overview fetching failed" });
  }
};

/* ---------------- SEATS ---------------- */
export const seats = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const org = await getOrg(orgId);
    const users = await getOrgUsers(orgId);

    const seatsByRoleMap: Record<string, number> = {};
    users.forEach((u) => {
      const role = u.role ?? "Member";
      seatsByRoleMap[role] = (seatsByRoleMap[role] ?? 0) + 1;
    });

    const base = new Date();
    const history = Array.from({ length: 6 }).map((_, idx) => {
      const monthsAgo = 5 - idx;
      const cutoff = new Date(base.getFullYear(), base.getMonth() - monthsAgo + 1, 1).getTime();
      const label = new Date(base.getFullYear(), base.getMonth() - monthsAgo, 1)
        .toLocaleString(undefined, { month: "short" });
      const used = users.filter((u) => u.enrolled_at && new Date(u.enrolled_at).getTime() < cutoff).length;
      return { month: label, used };
    });

    res.status(200).json({
      data: {
        totalSeats: org?.org_users_capacity ?? 0,
        usedSeats: org?.org_users_enrolled ?? users.filter((u) => u.enrolled_at).length,
        pendingInvites: users.filter((u) => !u.enrolled_at).length,
        planName: org?.plan ?? "—",
        seatsByRole: Object.entries(seatsByRoleMap).map(([role, count]) => ({ role, count })),
        history,
      },
      message: "Seat allotment fetched successfully",
    });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Seats fetching failed" });
  }
};

/* ---------------- ACTIVITY ---------------- */
export const activity = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const users = await getOrgUsers(orgId);
    const sessions = await getOrgSessions(orgId, users.map((u) => u.id));

    const now = new Date();
    const days = Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      return d.toISOString().slice(0, 10);
    });

    const last7Days = days.map((date) => {
      const daySessions = sessions.filter((s) => s.created_at?.slice(0, 10) === date);
      return {
        date,
        pitches: daySessions.length,
        activeUsers: new Set(daySessions.map((s) => s.user_id)).size,
      };
    });

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const thisMonthSessions = sessions.filter((s) => new Date(s.created_at).getTime() >= monthStart);

    const pitchesByUser: Record<string, number> = {};
    thisMonthSessions.forEach((s) => {
      const uid = String(s.user_id);
      pitchesByUser[uid] = (pitchesByUser[uid] ?? 0) + 1;
    });
    const nameOf = Object.fromEntries(users.map((u) => [String(u.id), u.name]));
    const topActiveMembers = Object.entries(pitchesByUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([memberId, pitches]) => ({ memberId, name: nameOf[memberId] ?? "Unknown", pitches }));

    res.status(200).json({
      data: {
        last7Days,
        totalPitchesThisMonth: thisMonthSessions.length,
        totalActiveUsersThisMonth: new Set(thisMonthSessions.map((s) => s.user_id)).size,
        topActiveMembers,
      },
      message: "Activity fetched successfully",
    });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Activity fetching failed" });
  }
};

/* ---------------- FOUNDER DRILL-DOWN ---------------- */
export const founderDrill = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const users = await getOrgUsers(orgId);
    const sessions = await getOrgSessions(orgId, users.map((u) => u.id));

    const founders = users
      .filter((u) => (u.role ?? "Founder") === "Founder")
      .map((u) => {
        const own = sessions.filter((s) => s.user_id === u.id); // already newest-first
        const chronological = [...own].reverse(); // oldest-first for trend/improvement

        const scoredChrono = chronological
          .map((s) => ({ s, score: pitchScoreFromReport(s.evaluation_report) }))
          .filter((x): x is { s: any; score: number } => x.score !== null);

        const avgScore = scoredChrono.length
          ? Math.round(scoredChrono.reduce((a, x) => a + x.score, 0) / scoredChrono.length)
          : null;
        const bestScore = scoredChrono.length ? Math.max(...scoredChrono.map((x) => x.score)) : null;
        const scoreImprovement =
          scoredChrono.length >= 2 ? scoredChrono[scoredChrono.length - 1].score - scoredChrono[0].score : 0;

        const readinessVals = own
          .map((s) => readinessFromReport(s.evaluation_report))
          .filter((v): v is number => v !== null);
        const readinessScore = readinessVals.length
          ? Math.round(readinessVals.reduce((a, b) => a + b, 0) / readinessVals.length)
          : 0;

        const completed = own.filter(isCompletePitch).length;
        const completionRate = own.length ? Math.round((completed / own.length) * 100) : 0;

        const byMonth: Record<string, number[]> = {};
        scoredChrono.forEach(({ s, score }) => {
          const key = s.created_at.slice(0, 7); // YYYY-MM
          (byMonth[key] ||= []).push(score);
        });
        const scoreHistory = Object.entries(byMonth)
          .sort(([a], [b]) => (a > b ? 1 : -1))
          .map(([date, vals]) => ({
            date,
            score: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
          }));

        const latestSession = own[0];
        const latestConfig = latestSession?.pitch_config ?? {};

        const recentPitches = own.slice(0, 5).map((s) => ({
          id: String(s.id),
          title: s.business_name ?? "Untitled",
          date: s.created_at,
          panelType: panelTypeLabel(s.mode),
          status: pitchStatusFromSession(s),
          score: pitchScoreFromReport(s.evaluation_report),
        }));

        return {
          memberId: String(u.id),
          name: u.name,
          email: u.email,
          avatarUrl: safeAvatarUrl(u.avatar_url),
          cohort: u.cohort ?? "Unassigned",
          industry: latestConfig.industry ?? "SaaS",
          fundingStage: latestConfig.fundingStage ?? "Pre-seed",
          totalPitches: own.length,
          avgScore,
          bestScore,
          readinessScore,
          completionRate,
          scoreImprovement,
          scoreHistory,
          lastFeedback: latestSession?.summary ?? null,
          recentPitches,
        };
      });

    res.status(200).json({ data: { founders }, message: "Founder drill-down fetched successfully" });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Founder drill-down fetching failed" });
  }
};

/* ---------------- MEMBER LIST ---------------- */
export const memberList = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const users = await getOrgUsers(orgId);
    const sessions = await getOrgSessions(orgId, users.map((u) => u.id));

    const byUser: Record<string, any[]> = {};
    sessions.forEach((s) => {
      (byUser[String(s.user_id)] ||= []).push(s);
    });

    const members = users.map((u) => {
      const own = byUser[String(u.id)] ?? [];
      const scored = own
        .map((s) => pitchScoreFromReport(s.evaluation_report))
        .filter((v): v is number => v !== null);
      const avgScore = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
      const latestConfig = own[0]?.pitch_config ?? {};

      return {
        id: String(u.id),
        name: u.name,
        email: u.email,
        avatarUrl: safeAvatarUrl(u.avatar_url),
        role: u.role ?? "Founder",
        status: !u.enrolled_at ? "invited" : "active",
        seatAssigned: !!u.enrolled_at,
        joinedAt: u.enrolled_at ?? u.created_at,
        lastActiveAt: u.last_active ?? null,
        totalPitches: own.length,
        avgScore,
        cohort: u.cohort ?? "Unassigned",
        industry: latestConfig.industry ?? "SaaS",
        fundingStage: latestConfig.fundingStage ?? "Pre-seed",
      };
    });

    res.status(200).json({ data: { members }, message: "Members fetched successfully" });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Members fetching failed" });
  }
};

/* ---------------- REPORTS ---------------- */
const buildReport = (sessions: any[], users: any[], rangeStart: Date, rangeEnd: Date) => {
  const inRange = sessions.filter((s) => {
    const t = new Date(s.created_at).getTime();
    return t >= rangeStart.getTime() && t < rangeEnd.getTime();
  });

  const scored = inRange
    .map((s) => pitchScoreFromReport(s.evaluation_report))
    .filter((v): v is number => v !== null);
  const avgScore = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
  const completed = inRange.filter(isCompletePitch).length;

  const nameOf = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const byFounder: Record<string, { name: string; pitches: number; scores: number[] }> = {};
  inRange.forEach((s) => {
    const uid = String(s.user_id);
    byFounder[uid] ||= { name: nameOf[s.user_id] ?? "Unknown", pitches: 0, scores: [] };
    byFounder[uid].pitches += 1;
    const score = pitchScoreFromReport(s.evaluation_report);
    if (score !== null) byFounder[uid].scores.push(score);
  });

  return {
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    totalPitches: inRange.length,
    completedPitches: completed,
    incompletePitches: inRange.length - completed,
    completionRate: inRange.length ? Math.round((completed / inRange.length) * 100) : 0,
    avgScore,
    activeFounders: Object.keys(byFounder).length,
    founders: Object.values(byFounder).map((f) => ({
      name: f.name,
      pitches: f.pitches,
      avgScore: f.scores.length ? Math.round(f.scores.reduce((a, b) => a + b, 0) / f.scores.length) : null,
    })),
  };
};

// weekly: pass any date inside the target week (defaults to current week)
export const weeklyReport = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const { date } = req.body;
    const users = await getOrgUsers(orgId);
    const sessions = await getOrgSessions(orgId, users.map((u) => u.id));

    if (date !== undefined && (typeof date !== "string" || date.length > 32)) {
      return res.status(400).json({ error: "date must be a valid date." });
    }
    const anchor = date ? new Date(date) : new Date();
    if (!Number.isFinite(anchor.getTime())) {
      return res.status(400).json({ error: "date must be a valid date." });
    }
    const start = new Date(anchor);
    start.setDate(anchor.getDate() - anchor.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);

    const report = buildReport(sessions, users, start, end);
    res.status(200).json({
      data: {
        type: "Weekly",
        title: `Weekly cohort summary — ${start.toDateString()} to ${end.toDateString()}`,
        generatedAt: new Date().toISOString(),
        ...report,
      },
      message: "Weekly report generated successfully",
    });
  } catch (error) {
    console.error("Report error:", error);
    res.status(500).json({ error: "Weekly report generation failed" });
  }
};

// monthly: pass month (0-11) + year, defaults to current month
export const monthlyReport = async (req: Request, res: Response) => {
  try {
    const orgId = req.organization!.orgCode;
    const { month, year } = req.body;
    const users = await getOrgUsers(orgId);
    const sessions = await getOrgSessions(orgId, users.map((u) => u.id));

    const now = new Date();
    const y = year ?? now.getFullYear();
    const m = month ?? now.getMonth();
    if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 0 || m > 11) {
      return res.status(400).json({ error: "month and year are invalid." });
    }
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 1);

    const report = buildReport(sessions, users, start, end);
    res.status(200).json({
      data: {
        type: "Monthly",
        title: `${start.toLocaleString(undefined, { month: "long", year: "numeric" })} performance report`,
        generatedAt: new Date().toISOString(),
        ...report,
      },
      message: "Monthly report generated successfully",
    });
  } catch (error) {
    console.error("Report error:", error);
    res.status(500).json({ error: "Monthly report generation failed" });
  }
};

/* ---------------- REPLAYS (not implemented yet) ---------------- */
export const replays = async (_req: Request, res: Response) => {
  res.status(200).json({ data: { replays: [], comingSoon: true }, message: "Replays coming soon" });
};
