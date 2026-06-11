import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Read .env directly to see if a valid custom GEMINI_API_KEY is present (legacy liveSocket only)
let customApiKey = "";
try {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    const match = envContent.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
    if (match) {
      const val = match[1].trim();
      if (val && val !== "your_gemini_api_key_here" && !val.startsWith("#")) {
        customApiKey = val;
      }
    }
  }
} catch {}

dotenv.config();

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  geminiApiKey: customApiKey || process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  geminiLiveModel: process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-latest",
  isGoogleCloud: !!process.env.K_SERVICE,
  jwtSecret: process.env.JWT_SECRET || "pitchnest-dev-secret-change-in-production",
  allowedOrigin: process.env.ALLOWED_ORIGIN || "http://localhost:5174",
  azureSpeechKey: process.env.AZURE_SPEECH_KEY || "",
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION || "",
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
  azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || "",
  azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY || "",
  azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview",
  nodeEnv: process.env.NODE_ENV || "development",
};

export function hasAzureOpenAiConfig(): boolean {
  return !!(
    config.azureOpenAiEndpoint &&
    config.azureOpenAiApiKey &&
    config.azureOpenAiDeployment
  );
}

export function hasOpenAiConfig(): boolean {
  return hasAzureOpenAiConfig() || !!config.openAiApiKey;
}

export function hasAzureTtsConfig(): boolean {
  return !!(config.azureSpeechKey && config.azureSpeechRegion);
}

if (!config.supabaseUrl || !config.supabaseAnonKey || !config.supabaseServiceRoleKey) {
  console.warn(
    "⚠️ Warning: SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY is missing in your backend environment variables!",
  );
}

if (!hasOpenAiConfig()) {
  console.error(
    "🚨 CRITICAL: No AI provider configured. Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_DEPLOYMENT (or OPENAI_API_KEY).",
  );
}

if (!hasAzureTtsConfig()) {
  console.error(
    "🚨 CRITICAL: Azure TTS is not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION for voice output.",
  );
}
