# CLI reference

`repo-scout [global options] <command> [options]`

## Global options

| Option                        | Meaning                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `--json`                      | Print the shared JSON envelope (identical to MCP `structuredContent`) |
| `--markdown`                  | Print a Markdown report (all score definitions included)              |
| `-o, --output <file>`         | Write the report to a file (refuses to overwrite without `--force`)   |
| `-v, --verbose`               | Debug logging on stderr (secrets redacted)                            |
| `--no-color`                  | Disable ANSI colour (also honours `NO_COLOR`)                         |
| `--offline`                   | Cache only; no network                                                |
| `--db <path>`, `--home <dir>` | Database / data directory                                             |

## Commands

| Command                                                                                                                 | Description                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `search <query...>` `[-p provider…] [--kind …] [-l lang] [-n N] [--offset N] [--sort score\|stars\|updated] [--deep N]` | Free-text search with Level-2 scoring                                                                               |
| `find <task...>` `[--deep N] [--min-score S] …`                                                                         | Full discovery pipeline with counts                                                                                 |
| `analyze <owner/repo>` `[--task text] [--refresh]`                                                                      | Level-3 static analysis                                                                                             |
| `compare <repo…>` `[--task text]`                                                                                       | Compare 2–6 repositories                                                                                            |
| `compose <task...>` `[--max-solutions N] [--deep N] [--packages]`                                                       | Multi-repo solution options                                                                                         |
| `plan <task...>` `[--option N]`                                                                                         | Implementation plan with approval gates                                                                             |
| `understand <task...>`                                                                                                  | Show task parsing (offline, instant)                                                                                |
| `alternatives <name>` / `related <repo>`                                                                                | Alternatives / related projects                                                                                     |
| `details <repo>` `[--readme] [--tree]`                                                                                  | Raw normalised metadata                                                                                             |
| `license <repo>` / `security <repo>` / `deps [repo] [--file manifest]`                                                  | Focused checks                                                                                                      |
| `trending` / `declining` / `hidden-gems`                                                                                | Trend radar: `--days N --min-stars N --max-stars N --min-activity-days N --min-age D --max-age D --topic T -l lang` |
| `providers`                                                                                                             | Provider availability, auth and limitations                                                                         |
| `cache status` / `cache clear --scope … -y`                                                                             | Database maintenance (`-y` required)                                                                                |
| `doctor`                                                                                                                | Diagnose node, config, database, network, token, providers, git                                                     |
| `mcp`                                                                                                                   | Start the MCP server on stdio                                                                                       |
| `integrate [agent]` / `skill`                                                                                           | Print agent config snippets / bundled skill path                                                                    |

## Exit codes

`0` success · `1` unexpected error or failed `doctor` · `2` invalid input/usage · `3` not found · `4` provider/network failure · `5` rate limited · `6` blocked by security policy · `7` configuration error · `8` database error.

Errors are printed as `error [CODE]: message` plus a `hint:` line where one exists; with `--json` they are the envelope (`ok:false`, `error`).

## Pagination, filtering, sorting

`-n/--limit` (≤ 50), `--offset`, `--sort`, `-l/--language`, `-p/--provider` (repeatable) work on `search`, `find`, `alternatives`, `related`. JSON output includes `page: { total, offset, limit, hasMore }`.
