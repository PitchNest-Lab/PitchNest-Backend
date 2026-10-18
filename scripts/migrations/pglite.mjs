// Shared helpers for the migration tooling: an in-memory Postgres (PGlite) with
// the parts of Supabase the PitchNest migrations rely on (the anon,
// authenticated and service_role roles and storage.buckets), plus a schema
// snapshot for comparisons. Nothing here touches a real database.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

/** A fresh database with Supabase's roles and storage.buckets stand-in. */
export async function freshDb() {
  const db = await PGlite.create({ extensions: { pgcrypto, uuid_ossp } });
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now()
    );
  `);
  return db;
}

export function readSql(file) {
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

/** Runs a script; on failure reports the statement area that broke. */
export async function run(db, label, sql) {
  try {
    await db.exec(sql);
  } catch (error) {
    const pos = Number(error?.position);
    const where = Number.isFinite(pos) ? sql.slice(Math.max(0, pos - 160), pos + 160) : "";
    throw new Error(`${label}: ${error?.message}${where ? `\n--- near ---\n${where}` : ""}`);
  }
}

/** Sorted lines describing everything in the public schema that matters. */
export async function snapshot(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  const lines = [];
  for (const r of await q(`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, coalesce(c.column_default, '') AS def
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`)) {
    lines.push(`column ${r.table_name}.${r.column_name} ${r.udt_name} null=${r.is_nullable} default=${r.def}`);
  }
  for (const r of await q(`SELECT viewname, definition FROM pg_views WHERE schemaname = 'public'`)) {
    lines.push(`view ${r.viewname} ${r.definition.replace(/\s+/g, " ").trim()}`);
  }
  for (const r of await q(`
    SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace`)) {
    lines.push(`constraint ${r.tbl}.${r.conname} ${r.def}`);
  }
  for (const r of await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`)) {
    lines.push(`index ${r.tablename}.${r.indexname} ${r.indexdef}`);
  }
  for (const r of await q(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           md5(replace(pg_get_functiondef(p.oid), E'\\r', '')) AS h,
           p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
           coalesce(array_to_string(p.proacl, ','), '') AS acl
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')`)) {
    lines.push(`function ${r.proname}(${r.args}) secdef=${r.prosecdef} cfg=${r.cfg} acl=${r.acl} body=${r.h}`);
  }
  for (const r of await q(`
    SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'storage.%'`)) {
    lines.push(`trigger ${r.tbl}.${r.tgname} ${r.def}`);
  }
  for (const r of await q(`
    SELECT tablename, policyname, permissive, roles::text AS roles, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS wc
    FROM pg_policies WHERE schemaname = 'public'`)) {
    lines.push(`policy ${r.tablename}.${r.policyname} ${r.permissive} ${r.roles} ${r.cmd} using(${r.qual}) check(${r.wc})`);
  }
  for (const r of await q(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, coalesce(array_to_string(c.relacl, ','), '') AS acl
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'S')`)) {
    lines.push(`relation ${r.relname} rls=${r.relrowsecurity} force=${r.relforcerowsecurity} acl=${r.acl}`);
  }
  for (const r of await q(`SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`)) {
    lines.push(`enum ${r.typname} ${r.labels}`);
  }
  for (const r of await q(`SELECT id, public FROM storage.buckets`)) {
    lines.push(`bucket ${r.id} public=${r.public}`);
  }
  return lines.sort();
}

export function diff(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    onlyA: a.filter((l) => !sb.has(l)),
    onlyB: b.filter((l) => !sa.has(l)),
  };
}
