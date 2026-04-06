# Brain Backup and Export

> Export all Open Brain tables to local JSON files for safekeeping.

## What It Does

Paginates through every Open Brain Supabase table (1 000 rows per request) and writes each one to a dated JSON file inside a local `backup/` directory. Prints live progress and a summary table so you know exactly what was saved.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Node.js 18+ installed
- A `.env.local` file in the recipe directory (or its parent) containing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
BRAIN BACKUP -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Project URL:           ____________
  Service-role key:      ____________

--------------------------------------
```

## Steps

1. **Copy the script into your project.** Place `backup-brain.mjs` wherever is convenient, or run it directly from this recipe folder.

2. **Create a `.env.local` file** next to the script (or one directory above it) with your Supabase credentials:

   ```text
   SUPABASE_URL=https://<your-project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
   ```

3. **Run the backup:**

   ```bash
   node backup-brain.mjs
   ```

   The script will read `.env.local` automatically. Alternatively, you can export the variables first:

   ```bash
   export SUPABASE_URL=https://<your-project-ref>.supabase.co
   export SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
   node backup-brain.mjs
   ```

4. **Check the output.** A `backup/` directory will be created containing one JSON file per table, each named `<table>-YYYY-MM-DD.json`.

## Expected Outcome

After running the script you should see live row counts for each table followed by a summary like this:

```
Open Brain Backup — 2026-04-06
Target: /path/to/backup

  thoughts: 1200 rows (1.4 MB)
  entities: 340 rows (98.2 KB)
  ...

--- Backup Summary ---
Date:  2026-04-06
Dir:   /path/to/backup

Table               Rows      Size
--------------------------------------
thoughts            1200    1.4 MB
entities             340   98.2 KB
...
--------------------------------------
TOTAL               1842    1.7 MB

Done. 7/7 tables exported successfully.
```

The `backup/` directory will contain one JSON file per table. Each file is a valid JSON array that can be re-imported or queried with any JSON tool.

## Troubleshooting

**Issue: "SUPABASE_URL not found" error**
Solution: Make sure `.env.local` exists next to the script (or one directory up) and contains a line starting with `SUPABASE_URL=`.

**Issue: "SUPABASE_SERVICE_ROLE_KEY not found" error**
Solution: Add your service-role key to `.env.local`. You can find it in your Supabase dashboard under Settings > API.

**Issue: "PostgREST error 401" or "PostgREST error 403"**
Solution: Your service-role key may be expired or incorrect. Regenerate it in the Supabase dashboard and update `.env.local`.
