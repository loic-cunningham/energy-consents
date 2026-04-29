# energy-consents

> A fast, resumable scraper for [energyconsents.scot](https://www.energyconsents.scot/ApplicationSearch.aspx?T=2) — every case, every document, every field.

Built with [Bun](https://bun.sh) + TypeScript. No headless browser, no jsdom — just raw HTTP, [`node-html-parser`](https://github.com/taoqf/node-html-parser), and a small ASP.NET WebForms client that replays `__VIEWSTATE` postbacks the way the page itself does.

## Features

- **Full corpus index** — paginates through every Advanced Search page and emits a single `case_refs.json`.
- **Every detail field** — every label/value, plus structured agent + applicant contact blocks.
- **Every document** — paginated documents tab, each row captured with date received, publication date, category, description, and the postback coordinates needed to fetch the file.
- **Real PDF downloads** — replays the ASP.NET `__doPostBack` chain to pull the actual file bytes (with the original filename from `Content-Disposition`).
- **Resumable** — JSONL output, dedupes by `caseRef` on every restart.
- **Bounded concurrency** — global HTTP cap via `p-limit`, per-case parallelism on top.
- **Pretty CLI** — yargs commands, `cli-progress` bar that keeps log lines above it, [`picocolors`](https://github.com/alexeyraspopov/picocolors) for colour.

## Install

You need [**Bun**](https://bun.sh) (this project uses `Bun.serve`, `bun:sqlite`, and `Bun.file` idioms — see `CLAUDE.md`).

```sh
curl -fsSL https://bun.sh/install | bash   # if you don't have bun yet
git clone https://github.com/<your-fork>/energy-consents
cd energy-consents
bun install
```

## Quickstart

```sh
# 1) crawl the search results (~30s)
bun run src/cli.ts index

# 2) scrape every case → data/energy_consents.jsonl  (~30 min, resumable)
bun run src/cli.ts scrape

# 3) pull the PDFs for any case you care about
bun run src/cli.ts download --case ECU00004696
```

Or via the npm scripts:

```sh
bun run index
bun run scrape
bun run download -- --case ECU00004696
```

## Output layout

Everything lives under `data/` as JSON / JSONL / binary files.

```
data/
├── case_refs.json                       # CaseRow[] — every case ref from the search
├── energy_consents.jsonl                # one CaseRecord per line (the bulk corpus)
└── <CASE_REF>/
    ├── case.json                        # CaseRecord, pretty-printed
    ├── documents.json                   # download manifest (when files were fetched)
    └── documents/
        └── <original-filename>.pdf
```

A `CaseRecord` looks like:

```jsonc
{
  "caseRef": "EC00002069",
  "projectName": "Loch Urr",
  "caseType": "Development",
  "projectType": "Wind Farm",
  "caseStatus": "Withdrawn",
  "detail": {
    "url": "https://www.energyconsents.scot/ApplicationDetails.aspx?cr=EC00002069",
    "fields": {
      "Project Type": "Wind Farm (Other Generating Station)",
      "Status": "Withdrawn",
      "Planning Authority": "Dumfries and Galloway Council",
      "Application Received Date": "19 Nov 2014",
      "Max Total MW Of Development Applied For": "83.20",
      "...": "..."
    },
    "contacts": [
      { "role": "Agent",     "lines": ["Axis PED", "Well House Barns, Chester, CH4 0DH", "..."] },
      { "role": "Applicant", "lines": ["Nick Taylor", "EON Climate & Renewable Developments Limited", "..."] }
    ]
  },
  "documents": [
    {
      "dateReceived": "18 May 2016",
      "publicationDate": "19 May 2016",
      "documentCategory": "ECU Correspondence (external)",
      "description": "Notification of withdrawal of application",
      "postbackTarget": "ctl00$ContentPlaceHolder1$grdResults$ctl02$AddButton",
      "documentId": "ContentPlaceHolder1_grdResults_AddButton_0",
      "pageOnDocsTab": 1,
      "rowIndexOnPage": 0,
      "downloadEndpoint": "https://www.energyconsents.scot/ApplicationDetails.aspx?cr=EC00002069"
    }
  ],
  "representations": [],
  "scrapedAt": "2026-04-29T20:59:00.000Z"
}
```

`postbackTarget` + `pageOnDocsTab` + `rowIndexOnPage` are the coordinates the `download` command needs. There is no static URL per document (see [Why no plain URL?](#why-no-plain-url-per-document) below).

## CLI

### Global options (apply to every command)

| Flag                 | Default                              | Notes                                              |
| -------------------- | ------------------------------------ | -------------------------------------------------- |
| `--base-url`         | `https://www.energyconsents.scot`    | Override the site root.                            |
| `--data-dir`         | `data`                               | Where every JSON/JSONL/binary goes.                |
| `--refs`             | `<data-dir>/case_refs.json`          | Override the index file.                           |
| `--output`           | `<data-dir>/energy_consents.jsonl`   | Override the JSONL corpus path.                    |
| `--http-concurrency` | `6`                                  | Global cap on in-flight HTTP requests.             |

### `index`

Walk the search-result pagination, write every case ref.

```sh
bun run src/cli.ts index
```

### `scrape`

Fetch case detail + documents + representations into JSONL. Optionally pull binaries too.

```sh
# whole corpus, resumable (default)
bun run src/cli.ts scrape

# just one case
bun run src/cli.ts scrape --case EC00002069

# first 50 cases, fresh start
bun run src/cli.ts scrape --limit 50 --no-resume

# scrape + pull every document binary
bun run src/cli.ts scrape --case EC00002069 --download
```

| Flag             | Default | Notes                                                          |
| ---------------- | ------- | -------------------------------------------------------------- |
| `--case <ref>`   | —       | Single case ref instead of the whole list.                     |
| `--limit <n>`    | —       | Stop after N cases.                                            |
| `--concurrency`  | `4`     | Cases worked on in parallel.                                   |
| `--resume`       | `true`  | Skip refs already in the JSONL. Use `--no-resume` to truncate. |
| `--download`     | `false` | Also pull every document into `data/<caseRef>/documents/`.     |

### `download`

Replays the postback chain to fetch real files.

```sh
# every doc for one case
bun run src/cli.ts download --case ECU00004696

# one specific doc (page + row from the JSONL)
bun run src/cli.ts download --case EC00002069 --page 1 --row 0

# every doc for every case (slow!)
bun run src/cli.ts download --all --concurrency 2
```

| Flag             | Default | Notes                                                       |
| ---------------- | ------- | ----------------------------------------------------------- |
| `--case <ref>`   | —       | Required unless `--all`.                                    |
| `--page <n>`     | —       | Documents-tab page (1-based). Single-doc mode.              |
| `--row <n>`      | —       | 0-based row on that page. Required with `--page`.           |
| `--all`          | `false` | Loop over every case in `case_refs.json`.                   |
| `--concurrency`  | `2`     | Cases in parallel when `--all`.                             |
| `--limit <n>`    | —       | Cap cases processed when `--all`.                           |

## Inspecting the data

```sh
# pretty-print one record
head -1 data/energy_consents.jsonl | jq

# variety summary
jq -r '"\(.caseRef) \(.caseStatus) docs=\(.documents|length) – \(.projectName)"' data/energy_consents.jsonl | head

# every document in the corpus, flattened
jq -rc '. as $c | .documents[] | [$c.caseRef, .pageOnDocsTab, .rowIndexOnPage, .documentCategory, .description] | @tsv' data/energy_consents.jsonl | head

# replay download for any row found in the JSONL
jq -rc '.caseRef as $c | .documents[] | "\($c) \(.pageOnDocsTab) \(.rowIndexOnPage)"' data/energy_consents.jsonl \
  | head -5 \
  | xargs -L1 -P4 bash -c 'bun run src/cli.ts download --case "$0" --page "$1" --row "$2"'
```

## Why no plain URL per document?

Each document is served by POST-ing the case page with `__EVENTTARGET=...$AddButton` and the current `__VIEWSTATE`. The response body **is** the file, with `Content-Disposition` giving the filename. There is no GET URL we can hand to a browser — the only way to fetch a file is to replay the postback chain (open the case → switch to Documents tab → page-forward to the right page → POST the AddButton). That is exactly what `bun run src/cli.ts download` does.

## Source layout

```
src/
├── cli.ts          yargs entry point — index / scrape / download
├── config.ts       base-url + path resolution
├── aspnet.ts       CookieJar, viewstate extraction, fetch wrapper, p-limit HTTP cap
├── parse.ts        HTML → typed records (CaseDetail, DocumentEntry, Representation)
├── index-step.ts   the search-result crawl
├── scrape.ts       per-case detail + paginated documents + representations
├── download.ts     single-doc + parallel all-docs-for-case + manifest writer
└── logger.ts       cli-progress wrapper that keeps log output above the bar
```

## Notes

- The site uses `__VIEWSTATE` heavily, so every browse step needs a fresh round-trip. Document downloads are particularly chatty: the response to an `AddButton` POST is the file body itself, so any subsequent download in the same case has to re-acquire viewstate by re-clicking the Documents tab and paging forward. `downloadAllDocsForCase` works around this by spawning a fresh per-doc session and parallelising via `p-limit` (subject to `--http-concurrency`).
- HTTP concurrency is global — a single `p-limit` instance is shared by every worker. Per-case concurrency is layered on top.
- Be polite. The defaults (`--concurrency 4 --http-concurrency 6`) keep the load gentle for a small public service. Don't crank them.

## License

MIT.
