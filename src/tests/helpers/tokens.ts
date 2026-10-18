import jwt from "jsonwebtoken";
import { config } from "../../config/env.ts";
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_KIND,
} from "../../utils/accessToken.ts";

/** Login-session tokens in the shape the app issues (see utils/accessToken.ts). */
function sign(payload: Record<string, unknown>): string {
  return jwt.sign({ kind: ACCESS_TOKEN_KIND, authVersion: 0, ...payload }, config.jwtSecret, {
    algorithm: "HS256",
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
    expiresIn: "1h",
  });
}

export function signUserToken(user: { id: number; email?: string }): string {
  return sign({ id: user.id, email: user.email, accountType: "user" });
}

export function signOrgToken(org: { id: number; email?: string; orgCode: string | number }): string {
  return sign({
    id: org.id,
    email: org.email,
    accountType: "organization",
    orgCode: String(org.orgCode),
  });
}
