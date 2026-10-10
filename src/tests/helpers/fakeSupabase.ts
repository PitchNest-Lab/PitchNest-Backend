/**
 * Minimal in-memory stand-in for the supabase-js client, covering exactly the
 * query-builder surface the code under test uses. No network, no real data.
 *
 * Semantics are deliberately simple: filters compare with String() equality
 * (PostgREST coerces types the same way for these columns), `select()` returns
 * whole rows, and every call is recorded so tests can assert what was — or was
 * NOT — touched (e.g. that no signed URL was minted for a foreign object).
 */

type Row = Record<string, any>;
type Filter = (row: Row) => boolean;

export interface StorageCall {
  op: "upload" | "createSignedUrl" | "remove" | "getPublicUrl" | "download";
  bucket: string;
  paths: string[];
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  storageCalls: StorageCall[] = [];
  /** Tables to fail on with a generic error (simulate outages). */
  failTables = new Set<string>();
  private nextId = 1000;

  seed(table: string, rows: Row[]): this {
    this.tables[table] = rows.map((r) => ({ ...r }));
    return this;
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  from(table: string) {
    return new Query(this, table);
  }

  rpc(_name: string, _args: unknown) {
    return Promise.resolve({ data: null, error: null });
  }

  storage = {
    from: (bucket: string) => ({
      upload: async (path: string) => {
        this.storageCalls.push({ op: "upload", bucket, paths: [path] });
        return { data: { path }, error: null };
      },
      createSignedUrl: async (path: string, ttl: number) => {
        this.storageCalls.push({ op: "createSignedUrl", bucket, paths: [path] });
        return { data: { signedUrl: `https://signed.test/${bucket}/${path}?ttl=${ttl}` }, error: null };
      },
      remove: async (paths: string[]) => {
        this.storageCalls.push({ op: "remove", bucket, paths: [...paths] });
        return { data: paths.map((name) => ({ name })), error: null };
      },
      getPublicUrl: (path: string) => {
        this.storageCalls.push({ op: "getPublicUrl", bucket, paths: [path] });
        return { data: { publicUrl: `https://public.test/${bucket}/${path}` } };
      },
      download: async (path: string) => {
        this.storageCalls.push({ op: "download", bucket, paths: [path] });
        return { data: null, error: { message: "not found" } };
      },
    }),
  };

  allocId(): number {
    return this.nextId++;
  }
}

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: any = null;
  private returning = false;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private rangeFromTo: [number, number] | null = null;

  constructor(private db: FakeSupabase, private table: string) {}

  select(_cols?: string) {
    if (this.op === "select") this.op = "select";
    else this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[]) {
    return this.insert(rows);
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: any) {
    this.filters.push((r) => String(r[col]) !== String(val));
    return this;
  }
  is(col: string, val: any) {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  in(col: string, vals: any[]) {
    const set = new Set(vals.map(String));
    this.filters.push((r) => set.has(String(r[col])));
    return this;
  }
  gt(col: string, val: any) {
    this.filters.push((r) => r[col] != null && String(r[col]) > String(val));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFromTo = [from, to];
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }

  then<T1 = any, T2 = never>(
    onFulfilled?: ((v: { data: any; error: any }) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onFulfilled, onRejected);
  }

  private matches(): Row[] {
    return this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
  }

  private shape(rows: Row[]): { data: any; error: any } {
    if (this.mode === "single") {
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
    }
    if (this.mode === "maybeSingle") {
      return rows.length <= 1
        ? { data: rows[0] ?? null, error: null }
        : { data: null, error: { message: "multiple rows" } };
    }
    return { data: rows, error: null };
  }

  private execute(): { data: any; error: any } {
    if (this.db.failTables.has(this.table)) {
      return { data: null, error: { message: "simulated outage" } };
    }
    const table = this.db.rows(this.table);

    if (this.op === "insert") {
      const inserted = this.payload.map((r: Row) => {
        const row: Row = {
          id: this.db.allocId(),
          created_at: new Date().toISOString(),
          ...(this.table === "session_starts" ? { started_at: new Date().toISOString() } : {}),
          ...r,
        };
        table.push(row);
        return { ...row };
      });
      return this.returning || this.mode !== "many" ? this.shape(inserted) : { data: null, error: null };
    }

    if (this.op === "update") {
      const hit = this.matches();
      for (const r of hit) Object.assign(r, this.payload);
      return this.returning || this.mode !== "many" ? this.shape(hit.map((r) => ({ ...r }))) : { data: null, error: null };
    }

    if (this.op === "delete") {
      const hit = new Set(this.matches());
      this.db.tables[this.table] = table.filter((r) => !hit.has(r));
      return { data: null, error: null };
    }

    let rows = this.matches().map((r) => ({ ...r }));
    for (const { col, asc } of [...this.orderBy].reverse()) {
      rows.sort((a, b) => {
        const x = a[col], y = b[col];
        if (x === y) return 0;
        return (x > y ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    if (this.rangeFromTo) rows = rows.slice(this.rangeFromTo[0], this.rangeFromTo[1] + 1);
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return this.shape(rows);
  }
}
