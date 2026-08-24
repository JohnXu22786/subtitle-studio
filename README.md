# subtitle-studio

A self-contained multilingual subtitle translation workflow plugin for **dsh**
(DeepSeek Harness), built around the "everything is a plugin" idea. It parses
and writes SRT/VTT subtitles, translates them sentence-by-sentence through a
configurable LLM, merges bilingual outputs, validates alignment, and processes
whole directories — exposed both as dsh tools (`ctx.tools`) and as a
dependency-free CLI.

> `subtitle-studio` is a new, self-contained implementation. Its subtitle
> parsers are written from scratch (no heavy subtitle libraries), its LLM layer
> speaks OpenAI-compatible HTTP out of the box (DeepSeek by default) and can
> plug into the harness's `ctx.llm` seam, and everything is UTF-8 on both ends.

---

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Using subtitle-studio as a dsh bundle](#using-subtitle-studio-as-a-dsh-bundle)
- [CLI](#cli)
- [Configuration](#configuration)
- [Glossary format](#glossary-format)
- [Library & service API](#library--service-api)
- [Testing](#testing)
- [Limitations](#limitations)
- [License](#license)

## Features

1. **Parsing & writing** — SRT and WebVTT with a tolerant state machine:
   - accepts missing sequence numbers, missing blank separators, CRLF, and a UTF
     BOM (UTF-8 / UTF-16LE / UTF-16BE);
   - keeps multi-line cue text and VTT identifiers/settings verbatim;
   - skips junk lines and malformed timecode lines, reporting them as issues
     instead of aborting;
   - output is always UTF-8 and round-trips preserve timing to the millisecond.

2. **Sentence-by-sentence translation** — batched requests over a character
   budget, JSON payloads keyed by cue index for reliable alignment, bounded
   retries (with a corrective nudge on malformed JSON), timeouts, and glossary
   injection. Works with any OpenAI-compatible endpoint (DeepSeek is default)
   or the dsh `ctx.llm` seam.

3. **Bilingual subtitles** — merge original + translation either *stacked*
   (translation lines under the original) or *interleaved* (alternating cues),
   with optional per-line tags and a separator. The timeline is copied verbatim
   from the source, so it is preserved by construction.

4. **Alignment validation** — checks translation count vs. source, missing and
   extra cues, empty translations, overlong cues that should be split, and
   timeline overlaps.

5. **Batch processing** — translate whole directories with a bounded concurrency
   pool, per-file retry with backoff, an atomic checkpoint file for pause/resume,
   and token/cost estimation (with approximate per-model rates that can be
   overridden).

6. **Two entry points** — five dsh tools (`sub_parse`, `sub_translate`,
   `sub_merge`, `sub_export`, `sub_glossary`) plus a full CLI.

## Installation

Requirements: Node.js ≥ 18.18.

```bash
# 1. install dev dependencies and build
npm install
npm run build

# 2. run the CLI directly
node bin/subtitle-studio.js --help

# or install the bin globally (makes `subtitle-studio` available)
npm link
```

The package ships **zero runtime dependencies**. TypeScript is only a dev
dependency (build to `lib/` with `tsc`).

## Using subtitle-studio as a dsh bundle

The package is a valid dsh **bundle**: `package.json` declares the bundle
manifest, `cordis.patch.yml` inserts the plugin row into a profile, and
`lib/index.js` exports the Cordis-style entry (`name` + `apply(ctx, config)`).

### 1. Add the bundle to a profile

```bash
dsh plugin --profile <name> add subtitle-studio
```

This installs the package and appends `subtitle-studio` to the profile's
`dsh.profile.bundles`. The profile loader then applies our patch (the
`cordis.patch.yml` shipped by the bundle), which inserts a row:

```yaml
- insert:
    - id: subtitle-studio
      name: subtitle-studio
      config:
        targetLanguages: []
        sourceLanguage: ''
```

### 2. What the plugin registers

- **Tools** on `ctx.tools` (registered when the `tools` service is available):

  | tool           | purpose                                                              |
  | -------------- | -------------------------------------------------------------------- |
  | `sub_parse`    | parse a subtitle file into structured cues (JSON output)             |
  | `sub_translate`| translate a subtitle file into one or more languages (LLM call)      |
  | `sub_merge`    | combine a source subtitle with a translation payload (stacked/interleaved) |
  | `sub_export`   | convert/export a subtitle to SRT or VTT (UTF-8), optionally bilingual |
  | `sub_glossary` | manage the JSON terminology glossary (list/add/remove/merge)         |

- **Service** `subtitleStudio` (when `ctx.provide` exists) exposing
  `parse`, `translate`, `merge`, `validate`, `glossary`, `cost`, `stringify`,
  `convert` — a convenient library surface for other plugins.

### 3. Plugin configuration

The plugin reads the `config` object of its patch row (and any profile
override). Keys:

| key                     | type            | default                         | meaning                                    |
| ----------------------- | --------------- | ------------------------------- | ------------------------------------------ |
| `llm.provider`          | `"openai"\|"dsh"` | `"openai"`                    | HTTP backend vs. harness `ctx.llm` seam    |
| `llm.baseUrl`           | string          | `https://api.deepseek.com/v1`   | OpenAI-compatible endpoint                 |
| `llm.apiKey`            | string          | —                               | API key; supports `${ENV_VAR}` expansion   |
| `llm.model`             | string          | `deepseek-chat`                 | model name                                 |
| `llm.timeoutMs`         | number          | `120000`                        | per-request timeout                        |
| `llm.maxRetries`        | number          | `2`                             | retries on transient failures              |
| `llm.jsonMode`          | boolean         | `true`                          | request a JSON object response             |
| `llm.chunkChars`        | number          | `3500`                          | cue-character budget per request           |
| `sourceLanguage`        | string          | `""` (auto)                     | source language tag                        |
| `targetLanguages`       | string[]        | `[]`                            | target languages for translation           |
| `glossary.paths`        | string[]        | `[]`                            | glossary JSON files (merged)               |
| `output.layout`         | `stacked\|interleaved` | `stacked`              | bilingual merge layout                     |
| `output.separator`      | string          | `""`                            | line between original & translated blocks  |
| `output.tagTarget`      | string          | —                               | per-line tag prefix for translated lines   |
| `output.format`         | `srt\|vtt`      | keep source                     | output container format                    |
| `output.utf8Bom`        | boolean         | `false`                         | write a UTF-8 BOM                          |
| `batch.concurrency`     | number          | `2`                             | parallel files during batch                |
| `batch.maxRetries`      | number          | `2`                             | per-file retries                           |
| `batch.checkpoint`      | string          | `subtitle-studio.checkpoint.json` | checkpoint path                          |
| `validation.maxChars`   | number          | `160`                           | CJK over-long cue threshold                |
| `validation.maxWords`   | number          | `40`                            | Latin over-long cue threshold              |

Example patch override (in the profile's own `cordis.patch.yml`, whole-row
config replacement — see the dsh docs on patch layer semantics):

```yaml
- id: subtitle-studio
  config:
    llm:
      provider: openai
      baseUrl: https://api.deepseek.com/v1
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
    sourceLanguage: en
    targetLanguages: [zh, ja]
    output:
      layout: stacked
```

> To use the harness's own LLM provider (e.g. the DeepSeek adapter configured in
> the harness), set `llm.provider: dsh`. The plugin then calls `ctx.llm.stream`.

### 4. Notes for harness authors

- The entry never imports `@deepseek-ai/cordis`; the context is consumed
  structurally, so the same source compiles with or without the harness
  installed. Type-augmentation fans can add
  `declare module '@deepseek-ai/cordis' { interface Context { subtitleStudio: ... } }`
  themselves.
- Tools are registered through `ctx.inject(['tools'], sub => …)` so the plugin
  starts even in a minimal profile; nothing hard-requires `ctx.llm` unless
  `provider: dsh` is set.

## CLI

```
subtitle-studio <command> [options]
```

All commands accept `--config <file.json>` to load the plugin-shaped config,
plus per-command flags (which override config).

### parse

```bash
subtitle-studio parse movie.srt
subtitle-studio parse movie.vtt --pretty       # full JSON
```

### translate

```bash
# one target language -> bilingual stacked SRT
subtitle-studio translate movie.srt \
  --target zh --source en \
  --glossary glossary.json \
  --output movie.zh.srt

# multiple targets -> fmt: <stem>.<target>.bilingual.<ext>
subtitle-studio translate movie.vtt --target zh --target fr --output movie.bilingual.vtt

# interleaved layout + shownote line tags
subtitle-studio translate movie.srt --target zh --layout interleaved --tag "[zh] " --output out.srt

# API key from environment
subtitle-studio translate movie.srt --target zh --api-key ${DEEPSEEK_API_KEY} --output out.srt

# persist a mid-run partial checkpoint
subtitle-studio translate movie.srt --target zh --output out.srt --save-partial partial.json
```

Flow: parse → validate timeline → print cost estimate → translate → validate
alignment → merge → write bilingual subtitle + `<name>.translation.json`.

### merge

```bash
# from a translation JSON file
subtitle-studio merge movie.srt translation.json --layout interleaved --output merged.srt

# or inline JSON
subtitle-studio merge movie.srt '{"entries":[{"index":1,"text":"你好"}]}' --layout stacked
```

### export

```bash
# convert srt -> vtt preserving timestamps
subtitle-studio export movie.srt --output movie.vtt

# bilingual export
subtitle-studio export movie.srt --output movie.vtt --translation translation.json --layout interleaved
```

### validate

```bash
subtitle-studio validate movie.srt                    # timeline sanity + overlaps
subtitle-studio validate movie.srt --compare translation.json  # alignment against a translation
subtitle-studio validate movie.srt --overlong         # over-length cue report
subtitle-studio validate movie.srt --no-overlap       # skip overlap checks
```

### glossary

```bash
subtitle-studio glossary list --path glossary.json
subtitle-studio glossary add --path glossary.json --source "DeepSeek Harness" --target "深度求索工具链" --scope zh
subtitle-studio glossary remove --path glossary.json --source "DeepSeek Harness"
subtitle-studio glossary merge --path glossary.json --with other.json
```

### batch

```bash
# dry-run cost estimate
subtitle-studio batch ./movies --output-dir ./out --target zh --estimate

# real run with 3 parallel workers and resume-capable checkpoint
subtitle-studio batch ./movies --output-dir ./out \
  --target zh --glossary glossary.json \
  --concurrency 3 --checkpoint cp.json --layout interleaved

# resume after an interruption (skips done files, retries failed)
subtitle-studio batch ./movies --output-dir ./out --target zh --checkpoint cp.json --resume
```

Batch notes:
- The output directory **mirrors the input tree**, so two files that share a
  basename (e.g. `a/clip.srt` and `b/clip.srt`) never collide
  (`out/a/clip.bilingual.srt`, `out/b/clip.bilingual.srt`).
- The output directory itself is excluded from scanning, so a batch never
  re-translates its own artifacts (`out/x.bilingual.bilingual.srt` can't
  happen).
- `--resume` re-queues files left `processing` by a crash, skips `done` files,
  and (with `--retry-failed`, the default) retries `failed` files with a fresh
  attempt budget. The checkpoint is written atomically after every file.

### cost

```bash
subtitle-studio cost movie.srt --target zh
subtitle-studio cost ./movies --target zh --target fr --model deepseek-chat --rate-in 0.27 --rate-out 1.10
```

## Configuration

The CLI mirrors the dsh plugin configuration (see the table above) through
`--config` or flags. API keys can reference environment variables:

```bash
node bin/subtitle-studio.js translate a.srt --target zh --api-key "${env:DEEPSEEK_API_KEY}"
```

Prices in the cost estimator are approximate list prices keyed by model
(`deepseek-chat`, `deepseek-reasoner`) and are always overridable with
`--rate-in`/`--rate-out` (or `llm` config equivalents).

## Glossary format

A glossary is a JSON document:

```json
{
  "name": "sample-glossary",
  "entries": [
    { "source": "DeepSeek Harness", "target": "深度求索工具链", "scope": "zh", "note": "official product name" },
    { "source": "hello", "target": "bonjour", "scope": "fr" },
    { "source": "bilingual", "target": "双语" }
  ]
}
```

- `source` → `target` map a term to its mandated translation.
- `scope` restricts an entry to one target language; entries without a scope
  apply to every language. This is how one glossary serves multiple targets.
- During translation the applicable entries are injected into the system prompt
  as mandatory terminology. The entry identity is `(source, target, scope)` —
  upserting the same key replaces it, different keys coexist.
- See `examples/glossary.json` and run `subtitle-studio glossary list`.

## Library & service API

The public entry `lib/index.js` re-exports the engine pieces directly as
functions:

```js
import {
  parseSubtitle, stringifySubtitle, convertSubtitle, detectFormat,
  translateCues, translateDocument,
  mergeBilingual, mergeWithEntries,
  validateSubtitle, validateTranslationAlignment,
  loadGlossaryFile, mergeGlossaries, buildGlossaryPrompt,
  createLlmClient, estimateCost,
} from 'subtitle-studio'
```

All timestamps are integer milliseconds; all file I/O is UTF-8.

## Testing

```bash
npm test
```

Runs `tsc` then the Node built-in test runner over `test/*.test.js`
(122 tests covering time parsing, SRT/VTT tolerance, encoding/BOM, merge,
validation, glossary, translation with a mocked HTTP backend, batch/checkpoint,
and the CLI + dsh tool/plugin surface).

## Limitations

- The token counter is a heuristic; use `--rate-in/--rate-out` for accurate
  billing, and treat cost prints as estimates.
- Interleaved bilingual output intentionally reuses the exact source timings
  for both cues, so the overlap validator flags them — validate the *source*
  document for overlaps, or exclude bilingual docs from overlap checks.
- `jsonMode` requires an endpoint that supports `response_format`; the client
  automatically retries without it if the provider rejects it with HTTP 400.
- The `dsh` LLM provider path assumes the harness `ctx.llm.stream` chunk shape;
  other chunk layouts degrade to generic text extraction.

## License

MIT — see [LICENSE](LICENSE).
