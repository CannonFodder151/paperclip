-- readCheckedOutIssueId resolves the issue a run holds checked out or is executing on
-- every issue write, so it must not scan the company. Both claim columns are null on
-- all but a few dozen rows, and the partial predicates keep each index to those rows.
-- The migration runner wraps every migration in a transaction
-- (packages/db/src/client.ts runInTransaction, plus drizzle's own transactional
-- migrator), so CREATE INDEX CONCURRENTLY is rejected with
-- "CREATE INDEX CONCURRENTLY cannot run inside a transaction block" — verified on
-- the live instance. The one-time build takes a ShareLock that only blocks writes,
-- not reads; the indexed columns are all null for every pre-existing row.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. These partial indexes are tiny (null claim columns are excluded), so the transactional build lock is the lower cost than the per-write company scan it removes.
CREATE INDEX IF NOT EXISTS "issues_company_checkout_run_idx" ON "issues" USING btree ("company_id","checkout_run_id") WHERE "issues"."checkout_run_id" is not null;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Same transactional-runner constraint as the checkout claim index above; the execution claim column is null for every pre-existing row, so the build scans almost nothing.
CREATE INDEX IF NOT EXISTS "issues_company_execution_run_idx" ON "issues" USING btree ("company_id","execution_run_id") WHERE "issues"."execution_run_id" is not null;
