import "./testEnv.ts";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.ts";
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, ACCESS_TOKEN_KIND } from "../utils/accessToken.ts";
import { supabase } from "../config/supabase.ts";
import {
  authMiddleware,
  organizationAuthMiddleware,
  requireOrgRole,
} from "../middleware/authMiddleware.ts";
import {
  orgLogin,
  toPublicOrganization,
  toPublicUser,
} from "../controllers/authController.ts";

type RecordedResponse = Response & { statusCode: number; body?: any };

function responseRecorder(): RecordedResponse {
  const res: Partial<RecordedResponse> = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this as RecordedResponse;
    },
    json(body: any) {
      this.body = body;
      return this as RecordedResponse;
    },
  };
  return res as RecordedResponse;
}

function requestWithToken(token: string, body: Record<string, unknown> = {}): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    body,
  } as Request;
}

const passwordHash = await bcrypt.hash("correct horse battery staple", 4);
const organizationRow = {
  id: 71,
  email: "owner@example.com",
  password: passwordHash,
  org_code: "12345",
  org_name: "Alpha Accelerator",
  plan: "enterprise",
  validity: new Date(Date.now() + 86_400_000).toISOString(),
  trial_status: "inactive",
};

const mutableSupabase = supabase as any;
const originalFrom = mutableSupabase.from;
let selectedTable = "";

mutableSupabase.from = (table: string) => {
  selectedTable = table;
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({
      data: table === "Organizations" ? organizationRow : null,
      error: null,
    }),
  };
  return query;
};

try {
  const forgedScopeToken = jwt.sign(
    {
      id: organizationRow.id,
      kind: ACCESS_TOKEN_KIND,
      accountType: "organization",
      orgCode: "99999",
    },
    config.jwtSecret,
    { algorithm: "HS256", issuer: ACCESS_TOKEN_ISSUER, audience: ACCESS_TOKEN_AUDIENCE },
  );
  const organizationRequest = requestWithToken(forgedScopeToken);
  const organizationResponse = responseRecorder();
  let organizationNextCalled = false;
  await organizationAuthMiddleware(
    organizationRequest,
    organizationResponse,
    (() => {
      organizationNextCalled = true;
    }) as NextFunction,
  );

  assert.equal(organizationNextCalled, true);
  assert.equal(selectedTable, "Organizations");
  assert.equal(organizationRequest.organization?.orgCode, "12345");
  assert.notEqual(organizationRequest.organization?.orgCode, "99999");

  const wrongSurfaceResponse = responseRecorder();
  let wrongSurfaceNextCalled = false;
  await authMiddleware(
    requestWithToken(forgedScopeToken),
    wrongSurfaceResponse,
    (() => {
      wrongSurfaceNextCalled = true;
    }) as NextFunction,
  );
  assert.equal(wrongSurfaceNextCalled, false);
  assert.equal(wrongSurfaceResponse.statusCode, 403);

  const userToken = jwt.sign(
    { kind: ACCESS_TOKEN_KIND, id: 9, accountType: "user" },
    config.jwtSecret,
    { algorithm: "HS256", issuer: ACCESS_TOKEN_ISSUER, audience: ACCESS_TOKEN_AUDIENCE },
  );
  const userOnOrgResponse = responseRecorder();
  let userOnOrgNextCalled = false;
  await organizationAuthMiddleware(
    requestWithToken(userToken),
    userOnOrgResponse,
    (() => {
      userOnOrgNextCalled = true;
    }) as NextFunction,
  );
  assert.equal(userOnOrgNextCalled, false);
  assert.equal(userOnOrgResponse.statusCode, 403);

  const roleRequest = {
    organization: { ...organizationRequest.organization!, role: "member" },
  } as Request;
  const roleResponse = responseRecorder();
  let roleNextCalled = false;
  requireOrgRole("owner", "admin")(
    roleRequest,
    roleResponse,
    (() => {
      roleNextCalled = true;
    }) as NextFunction,
  );
  assert.equal(roleNextCalled, false);
  assert.equal(roleResponse.statusCode, 403);

  const wrongPasswordResponse = responseRecorder();
  await orgLogin(
    { body: { email: organizationRow.email, password: "wrong" } } as Request,
    wrongPasswordResponse,
  );
  assert.equal(wrongPasswordResponse.statusCode, 401);
  assert.equal(wrongPasswordResponse.body?.token, undefined);

  const loginResponse = responseRecorder();
  await orgLogin(
    {
      body: {
        email: organizationRow.email,
        password: "correct horse battery staple",
      },
    } as Request,
    loginResponse,
  );
  assert.equal(loginResponse.statusCode, 200);
  assert.equal(loginResponse.body.user.accountType, "organization");
  assert.equal(loginResponse.body.user.orgCode, "12345");
  const decoded = jwt.verify(loginResponse.body.token, config.jwtSecret) as any;
  assert.equal(decoded.accountType, "organization");
  assert.equal(decoded.orgCode, "12345");

  const publicUser = toPublicUser({
    id: 5,
    name: "Ada Founder",
    email: "ada@example.com",
    password: "must-not-leak",
    role: "Founder",
    isEmailVerified: true,
  });
  assert.equal(publicUser.name, "Ada Founder");
  assert.equal(publicUser.accountType, "user");
  assert.equal("password" in publicUser, false);

  const publicOrganization = toPublicOrganization(organizationRow);
  assert.equal(publicOrganization.name, "Alpha Accelerator");
  assert.equal(publicOrganization.accountType, "organization");
  assert.equal("password" in publicOrganization, false);

  console.log("Organization security tests passed.");
} finally {
  mutableSupabase.from = originalFrom;
}
