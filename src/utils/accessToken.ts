import jwt, { type JwtPayload, type VerifyOptions } from "jsonwebtoken";
import { config } from "../config/env.ts";

export const ACCESS_TOKEN_ISSUER = "pitchnest";
export const ACCESS_TOKEN_AUDIENCE = "pitchnest-web";
export const ACCESS_TOKEN_KIND = "access";

const VERIFY_OPTIONS: VerifyOptions = {
  algorithms: ["HS256"],
  issuer: ACCESS_TOKEN_ISSUER,
  audience: ACCESS_TOKEN_AUDIENCE,
};

export interface AccessTokenPayload extends JwtPayload {
  kind: typeof ACCESS_TOKEN_KIND;
  id: number;
  rememberMe?: boolean;
  authVersion?: number;
  accountType?: "user" | "organization";
  orgCode?: string;
}

/** Accept only login-session JWTs, not another token class sharing the key. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret, VERIFY_OPTIONS);
  const payload = decoded as JwtPayload;
  if (
    typeof decoded === "string" ||
    payload.kind !== ACCESS_TOKEN_KIND ||
    !Number.isInteger(payload.id)
  ) {
    throw new Error("Invalid access token payload");
  }
  return payload as AccessTokenPayload;
}
