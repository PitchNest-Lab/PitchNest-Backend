/**
 * Test environment. Import this FIRST in every security test file: static
 * imports evaluate in order, so these values are in place before config/env.ts
 * reads process.env. Values are dummies — no real service is ever contacted.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-only-jwt-secret-not-used-anywhere-real";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.RESEND_API_KEY = "re_test_dummy_never_sent"; // Resend refuses an empty key at import; no test reaches the real Resend (auth-email.test.ts uses a local stand-in).
process.env.FLW_SECRET_KEY = "";
process.env.AZURE_OPENAI_ENDPOINT = "";
process.env.AZURE_OPENAI_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.AZURE_SPEECH_KEY = "";
process.env.AZURE_SPEECH_REGION = "";

export const TEST_JWT_SECRET = process.env.JWT_SECRET;
