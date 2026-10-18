// Imported FIRST by every test file. ES modules evaluate imports in order, so
// this runs before any controller or service module is loaded.
//
// Analytics writes go to the real Supabase project configured in .env; tests
// stub the database only partially, so recording is switched off here.
process.env.PITCHNEST_ANALYTICS = "off";

export {};
