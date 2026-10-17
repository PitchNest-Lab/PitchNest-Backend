-- PitchNest schema snapshot: READ-ONLY.
--
-- Lists every table column (type, NOT NULL, default), constraint, index,
-- trigger, row-level security setting, policy and function in the public
-- schema, one row each, so two databases can be compared line by line.
-- Function bodies are summarised as an md5 of their whitespace-normalised
-- definition.
--
-- Run it in the Supabase SQL editor and download the result as CSV (Markdown
-- pads every line to the widest cell and becomes very large).

SELECT kind, object, definition
FROM (
  SELECT 'column' AS kind,
         c.relname || '.' || a.attname AS object,
         format_type(a.atttypid, a.atttypmod)
           || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
           || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') AS definition
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'

  UNION ALL
  SELECT 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'

  UNION ALL
  SELECT 'index', c.relname || '.' || i.relname, pg_get_indexdef(i.oid)
  FROM pg_index x
  JOIN pg_class c ON c.oid = x.indrelid
  JOIN pg_class i ON i.oid = x.indexrelid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'

  UNION ALL
  SELECT 'trigger', c.relname || '.' || g.tgname, pg_get_triggerdef(g.oid)
  FROM pg_trigger g
  JOIN pg_class c ON c.oid = g.tgrelid
  WHERE c.relnamespace = 'public'::regnamespace AND NOT g.tgisinternal

  UNION ALL
  SELECT 'rls', c.relname, CASE WHEN c.relrowsecurity THEN 'on' ELSE 'off' END
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'

  UNION ALL
  SELECT 'policy', p.tablename || '.' || p.policyname,
         p.cmd || ' to ' || array_to_string(p.roles, ',')
           || ' using ' || coalesce(p.qual, '-') || ' check ' || coalesce(p.with_check, '-')
  FROM pg_policies p
  WHERE p.schemaname = 'public'

  UNION ALL
  SELECT 'function',
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         CASE WHEN p.prosecdef THEN 'security definer, ' ELSE '' END
           || 'md5 ' || md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g'))
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
) snapshot
ORDER BY kind, object;
