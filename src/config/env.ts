import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Read .env directly to see if a valid custom GEMINI_API_KEY is present
let customApiKey = "";
try {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    // Parse key matching pattern
    const match = envContent.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
    if (match) {
      const val = match[1].trim();
      if (val && val !== "your_gemini_api_key_here" && !val.startsWith("#")) {
        customApiKey = val;
      }
    }
  }
} catch (err) {}

dotenv.config();

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  geminiApiKey: customApiKey || process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash-exp",
  isGoogleCloud: !!process.env.K_SERVICE,
};

// Check for critical missing configurations
if (!config.supabaseUrl || !config.supabaseAnonKey) {
  console.warn("⚠️ Warning: SUPABASE_URL or SUPABASE_ANON_KEY is missing in your backend environment variables!");
}

if (!config.geminiApiKey) {
  console.error("🚨 CRITICAL ERROR: GEMINI_API_KEY is missing from environment variables!");
}
