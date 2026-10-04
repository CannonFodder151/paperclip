import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// readCheckedOutIssueId anchors an unanchored timer run to the issue it
// holds checked out or is executing. Both claim columns are null on all
// but a few dozen rows per company, so the lookup ORs two partial
// indexes instead of scanning the company's issues on every write.
d("issue claim run index migration", () => {
  it("applies full migration chain and uses the new indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("aut5543-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'issues'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("issues_company_checkout_run_idx");
    expect(names).toContain("issues_company_execution_run_idx");

    // The claim lookup is the hot path: every unanchored issue write runs
    // it, and the planner must BitmapOr the two partial indexes instead of
    // reading the whole company's issues. The embedded database is empty, so
    // assert each partial index directly — a backward scan of
    // issues_company_updated_idx is free when there is nothing to filter.
    await sql.unsafe("SET enable_seqscan = off");
    for (const column of ["checkout_run_id", "execution_run_id"]) {
      const plan = await sql.unsafe(
        `EXPLAIN SELECT id FROM issues WHERE company_id = '00000000-0000-0000-0000-000000000001' AND ${column} = '00000000-0000-0000-0000-000000000001'`,
      );
      const planText = plan.map((r) => Object.values(r)[0]).join("\n");
      expect(planText).toContain(`issues_company_${column.replace("_id", "")}_idx`);
    }

    // Idempotency: re-running the migration statements against an already
    // migrated database must be a no-op, not an error.
    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0298_issue_claim_run_indexes.sql", import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  }, 240_000);
});
