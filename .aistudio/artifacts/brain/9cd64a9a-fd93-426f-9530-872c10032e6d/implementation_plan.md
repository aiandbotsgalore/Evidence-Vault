# Evidence Vault

Evidence Vault is a lean, zero-friction local workbench for investigative documentary writers to ingest heterogeneous source files (WebVTT/SRT transcripts, legal filings, witness statements, and field notes), deterministically chunk them with exact timestamp or page provenance, enrich them with `gemini-4-argon` semantic classification, and generate timeline-ready citation tags.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and UX refinements have been incorporated into the blueprint:

- **Quote Citation Sanitization & Verbatim Enforcement**: Every generated `quote_snippet` inside `[Speaker/Source Coordinate "Quote snippet"]` is validated to be an exact verbatim substring of the source chunk text (falling back to a deterministic verbatim lead clause if an LLM snippet ever drifts). Any inner double quotes (`"`, `“`, `”`) inside the snippet are strictly normalized to single quotes (`'`) so downstream timeline regex parsers (`\[.*? "(.*?)"\]`) never break.
- **Sequential Batch Ceiling (30 Chunks per Request)**: During `gemini-4-argon` enrichment, parsed chunks are processed in sequential batches of up to **30 chunks per API call**, accompanied by a real-time batch progress bar (`Enriching batch 1 of 3 • 30/78 chunks...`) in the ingestion drawer.
- **Resilient Transcript & Speaker Regex**: The deterministic VTT/SRT/transcript parser handles both dot and comma millisecond separators (`00:01:23.456`, `00:01:23,456`, and `[01:23:45]`), and automatically extracts and strips speaker labels from WebVTT voice tags (`<v Speaker Name>`), bracketed prefixes (`[Speaker Name]:`), and standard dialogue prefixes (`Speaker Name:`).
- **Scoped Sample Data (`is_sample: true`)**: Pre-loaded investigative demo sources and chunks carry an explicit `is_sample: true` flag. Clicking **"Clear Sample Data"** selectively purges only records with `is_sample: true`, preserving all user-ingested documents and chunks intact.
- **Interactive Thematic Synthesis ("Ask Vault")**: Submitting an "Ask Vault (Argon)" query synthesizes an investigative answer with clickable inline citation tags and filters the main feed to the cited evidence cards.

---

## 1. Overview & Core Concept

- **What It Does**: Normalizes raw transcripts (`.vtt`, `.srt`, timestamped `.txt`) and written documents (`.md`, `.txt` legal filings and notes) into an immutable, searchable evidence catalog. Deterministic regex parsers handle all text segmentation, speaker detection, and coordinate extraction locally, while `gemini-4-argon` provides structured semantic enrichment (`verified_record`, `spoken_statement`, `allegation_or_claim`, `editorial_note`) in controlled 30-chunk batches.
- **Target Audience / Persona**: Investigative journalists, documentary filmmakers, and research producers preparing source material for timeline scripting.
- **Key Value**: Guarantees strict source provenance, parser-safe citation brackets (`[Speaker/Source Coordinate "Quote snippet"]`), and instant local search without enterprise database bloat or manual timestamp calculation.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Immediate Exploration & Scoped Demo Reset**: On first load, the user sees the pre-loaded investigative dataset (`is_sample: true`) across the Left Rail source list and Center Canvas evidence feed. Clicking **"Clear Sample Data"** removes only the demo items while leaving any user-ingested sources untouched.
  2. **Drag-and-Drop Ingestion & Metadata Drawer**: Dropping a `.vtt`, `.srt`, `.txt`, or `.md` file onto the workbench (or clicking **Ingest Source**) opens a slide-over Metadata Drawer with auto-detected defaults for **Source Title**, **Source Type** (`archival_audio`, `court_filing`, `witness_interview`, `editorial_note`), and **Default Speaker / Author**, plus a live preview of deterministically parsed chunks, detected speaker tags, and sanitized citation pills.
  3. **Sequential 30-Chunk Batch Argon Enrichment**: Confirming ingestion processes chunks in sequential batches of 30 via `gemini-4-argon`, displaying a crisp progress bar with current batch and chunk counts before appending the enriched, immutable chunks to the vault.
  4. **Dual-Mode Search & Ask Vault**: Typing in the unified search bar filters cards at zero latency by keyword, speaker, entity, or coordinate. Clicking **Ask Vault (Argon)** runs a thematic query across the corpus, rendering an analytical synthesis banner with clickable citations and filtering the card feed to matching evidence.
  5. **One-Click Exports**: Clicking **Export Corpus (JSONL)** or **Export Evidence Map (Markdown)** immediately downloads the normalized downstream files.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: High-density archival research console inspired by professional NLE timeline workbenches and investigative newsroom tools.
  - *Color Palette & Mood*:
    - **60% Dominant Canvas**: Deep obsidian slate (`#0B0F17` primary canvas, `#111827` structural panels).
    - **30% Structural Surfaces**: Crisp `1px` slate hairlines (`#1E293B`), elevated card surfaces (`#151E2E`), and high-contrast readable typography (`#F8FAFC` primary, `#94A3B8` secondary).
    - **10% Semantic & Action Accents**: Archival Amber (`#F59E0B`) for primary interactive affordances, progress indicators, and citation copy states; semantic text + icon indicators for classifications:
      - `verified_record`: Emerald (`#10B981`)
      - `spoken_statement`: Sky Blue (`#38BDF8`)
      - `allegation_or_claim`: Amber/Orange (`#F59E0B`)
      - `editorial_note`: Violet/Slate (`#A78BFA`)
  - *Typography & Hierarchy*:
    - **Display & UI Structure**: `Plus Jakarta Sans` (SemiBold/Bold) for workspace headers, source titles, and navigation.
    - **Body & Transcript Prose**: `Public Sans` (Regular/Medium) at `14px–15px` with `1.6` line height for effortless reading of testimony and legal clauses.
    - **Coordinates, Timestamps & Citation Tags**: `JetBrains Mono` with `tabular-nums` for millisecond timestamps, page coordinates, chunk IDs, and bracketed citation strings.
  - *Component Styling & Layout*:
    - Full-viewport desktop workbench (`1440px` baseline) with a fixed `280px` Left Rail, a sticky Top Bar following the 3-zone contract, and a scrollable Center Canvas.
    - Single-elevation card depth (`1px` subtle border, no nested card boxes or thick left borders). Static metadata (source category, chunk counts, named entities, timestamps) rendered as clean unboxed inline text separated by `·` bullets.

- **Interactive Feedback & Motion**:
  - Instant `<150ms` transitions on filter tabs and card hover states.
  - Clicking a citation bracket triggers an immediate `"Copied to clipboard"` state swap with a checkmark icon and subtle amber border highlight.
  - Determinate batch progress bar (`0% -> 100%`) during sequential 30-chunk `gemini-4-argon` ingestion passes.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Deterministic Client-Side Parsing & Resilient Speaker/Timestamp Regex**
  - *Chosen Approach*: Parse WebVTT, SRT, timestamped transcripts, and legal/Markdown documents in TypeScript using deterministic regex rules that normalize both `.` and `,` millisecond delimiters (`00:01:23.456` / `00:01:23,456`) and strip/extract speakers from `<v Speaker>`, `[Speaker]:`, or `Speaker:` prefixes before grouping into 30–60s turns.
  - *Why*: Eliminates timestamp drift, handles heterogeneous caption exports cleanly, and attributes speaker turns accurately without LLM guesswork.

- **Decision 2: Strict Verbatim Quote Validation & Quote Sanitization**
  - *Chosen Approach*: Validate that the `quote_snippet` returned for each chunk exists verbatim inside `chunk.text` (ignoring smart-quote variance); if not, deterministically extract a clean verbatim clause from `chunk.text`. Before assembling `[Speaker/Source Coordinate "Quote snippet"]`, replace all inner double quotes (`"`, `“`, `”`) inside the snippet with single quotes (`'`).
  - *Why*: Guarantees 100% documentary quote accuracy and prevents inner double quotes from prematurely terminating downstream timeline regex parsers.

- **Decision 3: Sequential 30-Chunk Batching via Server-Side Express Proxy**
  - *Chosen Approach*: Chunk arrays on the client are sliced into batches of at most `BATCH_SIZE = 30` and sent sequentially to `POST /api/enrich-chunks` (`gemini-4-argon` with structured `responseSchema`), updating a live progress indicator after each batch completes.
  - *Why*: Prevents token truncation and request timeouts on long 2-hour podcast or deposition transcripts while giving the user clear visual progress.

- **Decision 4: Scoped Sample Data (`is_sample: true`) in LocalStorage**
  - *Chosen Approach*: Tag all pre-loaded demo sources and chunks with `is_sample: true`. Filter them out selectively when the user clicks **"Clear Sample Data"**.
  - *Why*: Allows users to test the workbench immediately and ingest their own files alongside sample data, then purge the demo records later without losing their own work.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        EVIDENCE VAULT WORKBENCH (React)                      │
├──────────────────────────────────────────────────────────────────────────────┤
│  Top Bar (3-Zone Contract)                                                   │
│  [Evidence Vault] ── [All · Verified · Statements · Claims · Notes] ── [+ Ingest]│
├─────────────────────────┬────────────────────────────────────────────────────┤
│  Left Rail (280px)      │  Center Canvas                                     │
│  ┌───────────────────┐  │  ┌──────────────────────────────────────────────┐  │
│  │ Sources Catalog   │  │  │ Unified Search & Ask Vault (Argon) Bar       │  │
│  │ • All Sources     │  │  │ [Keyword Filter / Ask Argon...]  [Export ▾]  │  │
│  │ • Cawffee Tawk..  │  │  └──────────────────────────────────────────────┘  │
│  │ • Doc: Filing     │  │  ┌──────────────────────────────────────────────┐  │
│  │ • Witness Notes   │  │  │ Argon Synthesis Drawer (When Query Active)   │  │
│  ├───────────────────┤  │  │ Memo + Clickable Inline Citation Pills       │  │
│  │ Verification Tags │  │  └──────────────────────────────────────────────┘  │
│  │ • verified_record │  │  ┌──────────────────────────────────────────────┐  │
│  │ • spoken_statement│  │  │ Evidence Chunk Card Feed                     │  │
│  │ • allegation_claim│  │  │ ┌──────────────────────────────────────────┐ │  │
│  │ • editorial_note  │  │  │ │ [Eric Hecker 2:02:15 "who do you..."] 📋 │ │  │
│  ├───────────────────┤  │  │ │ Verified / Spoken · 02:02:15.000 · ID    │ │  │
│  │ Vault Actions     │  │  │ │ Analytical Summary (1-sentence Argon)    │ │  │
│  │ • Export JSONL    │  │  │ │ Raw Verbatim Excerpt                     │ │  │
│  │ • Export Markdown │  │  │ │ Entities: Eric Hecker · Raytheon · ...   │ │  │
│  │ • Clear Sample    │  │  │ └──────────────────────────────────────────┘ │  │
│  └───────────────────┘  │  └──────────────────────────────────────────────┘  │
└─────────────────────────┴────────────────────────────────────────────────────┘
               │                                           │
               ▼                                           ▼
┌─────────────────────────────────┐         ┌──────────────────────────────────┐
│ Deterministic Parser & Sanitizer│         │ Express API Proxy (server.ts)    │
│ • VTT/SRT (, & . ms) Regex      │         │ • POST /api/enrich-chunks        │
│ • <v Name>, [Name]:, Name: strip│         │   (Max 30 chunks per batch)      │
│ • 30–60s Turn Aggregator        │         │ • POST /api/ask-vault            │
│ • Verbatim Substring Validator  │         │ • Model: gemini-4-argon          │
│ • Inner Quote -> ' Sanitizer    │         │ • Structured JSON responseSchema │
└─────────────────────────────────┘         └──────────────────────────────────┘
```

### Data Model & State

- **`SourceDocument`**:
  - `source_id`: Immutable string identifier (e.g., `src_cawffee_20261026`).
  - `title`: Display title (e.g., `"Cawffee Tawk 2026-10-26"` or `"Doc: Filing"`).
  - `source_type`: `'archival_audio' | 'court_filing' | 'witness_interview' | 'editorial_note'`.
  - `default_speaker`: Default speaker or author string.
  - `file_name`: Original filename.
  - `ingested_at`: ISO timestamp.
  - `chunk_count`: Number of generated chunks.
  - `is_sample`: `boolean` (`true` for pre-loaded demo sources, `false` for user-ingested sources).

- **`EvidenceChunk`**:
  - `chunk_id`: Immutable deterministic ID (e.g., `chk_src1_001`).
  - `source_id`: Foreign key to `SourceDocument`.
  - `source_title`: Denormalized source title.
  - `source_type`: Denormalized source type.
  - `speaker`: Speaker or source prefix used in citation (e.g., `"Eric Hecker"` or `"Doc: Filing"`).
  - `coordinate`: Formatted time or page indicator (e.g., `"2:02:15"` or `"p. 4"`).
  - `start_ms`: Number or `null` (exact start milliseconds for transcripts).
  - `end_ms`: Number or `null` (exact end milliseconds for transcripts).
  - `page_or_section`: String or `null` (e.g., `"p. 4, § 2.1"` for written documents).
  - `text`: Full verbatim chunk text (with raw `<v Speaker>` tags cleanly stripped).
  - `quote_snippet`: Exact verbatim substring from `text` with any internal double quotes replaced by `'`.
  - `citation_pill`: Exact formatted string `[Speaker/Source Coordinate "Quote snippet"]`.
  - `classification`: `'verified_record' | 'spoken_statement' | 'allegation_or_claim' | 'editorial_note'`.
  - `summary`: 1-sentence analytical distillation from `gemini-4-argon`.
  - `named_entities`: `string[]` of referenced people, organizations, or locations.
  - `is_sample`: `boolean` (`true` for pre-loaded demo chunks, `false` for user-ingested chunks).

### Interactive Component & State Mapping

- **Deterministic Transcript & Document Parser**:
  - **Timestamp Regex**: Matches `(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?` across VTT/SRT arrow lines (`-->`) and inline `[HH:MM:SS]` or `[MM:SS.mmm]` markers, converting accurately to exact milliseconds (`start_ms`, `end_ms`).
  - **Speaker Extraction Regex**: Detects and strips `<v\s+([^>]+)>(.*?)(?:<\/v>)?`, `^\[([^\]]+)\]:\s*`, and `^([A-Z][A-Za-z0-9\s.'-]{1,35}):\s+` at the start of cue lines, assigning the detected speaker to the segment or falling back to `default_speaker`.
  - **30–60s Turn Grouping**: Aggregates consecutive cues from the same speaker into 30–60 second semantic segments, splitting immediately when the speaker changes or the duration reaches 60 seconds.
- **Quote Sanitization & Citation Builder (`buildCitationPill`)**:
  - Verifies that `candidateQuote` appears verbatim within `chunk.text` (normalizing curly quotes during comparison). If absent or empty, extracts a clean verbatim clause (up to ~85 characters) directly from `chunk.text`.
  - Sanitizes the verified substring by replacing all `"` / `“` / `”` with `'` and collapsing newlines/extra spaces, then formats `[Speaker Coordinate "SanitizedQuote"]`.
- **Sequential Batch Enrichment (`BATCH_SIZE = 30`)**:
  - Splits pending chunks into arrays of length `<= 30`.
  - Iterates sequentially through each batch, updating UI state (`currentBatch`, `totalBatches`, `processedChunks`, `totalChunks`) and rendering a progress bar in the ingestion drawer.
- **Scoped Demo Data Management**:
  - The Left Rail displays a `"Clear Sample Data"` action whenever `sources.some(s => s.is_sample)` is true, removing only `is_sample: true` sources and chunks from state and `localStorage`.

---

## 5. Storage Layer & Custom Metadata Tag System (Dexie IndexedDB v2)

- **Dexie.js IndexedDB Schema**:
  - `sources`: `source_id, title, source_type, is_sample`
  - `chunks`: `chunk_id, source_id, speaker, coordinate, classification, is_sample, *named_entities, *custom_tags`
- **Tag Management System**:
  - **EvidenceCard Tag Row**: Displays all active custom tags with delete (`X`) buttons, a `+ Tag` creation input with Enter key submit, and one-click quick preset suggestions (`#timeline`, `#witness`, `#key-document`, `#corroborated`, `#contradiction`, `#alibi`).
  - **IndexedDB Multi-Entry Queries**: Indexed by `*custom_tags` in Dexie, supporting sub-millisecond retrieval and real-time count aggregation across the vault.
  - **Left Rail Tag Explorer**: Renders a dedicated Custom Tags section with real-time chunk count badges and click-to-filter toggling.
  - **Feed Context Filter Badge**: Active tag filters display a dismissible tag indicator badge (`Tag: #timeline (x)`) in the main header.
- **Fail-Safe UI & ErrorBoundary**:
  - Top-level `ErrorBoundary` catches rendering and runtime issues gracefully, displaying recovery options without blanking the screen.

---

## 6. Large Dataset Performance Architecture

- **Pagination & Bounded DOM Footprint**:
  - `PAGE_SIZE = 30`: Renders strictly the active 30-card slice in the DOM at any time.
  - Interactive pagination toolbar with previous/next navigation, dynamic numeric page pills, and "Showing X–Y of Z chunks (Page N of M)" statistics.
- **IndexedDB Query Offloading (`queryVaultChunks`)**:
  - Query filtering, sorting, counting, and slicing are offloaded directly to Dexie IndexedDB via `.where()`, `.offset()`, `.limit(30)`, and `.count()`.
  - Compound index `[source_id+classification]` in Dexie schema version 3 enables sub-millisecond classification counts and filtered retrievals without full table scans.
  - Classification counts in the Left Rail are calculated via Dexie index count queries without deserializing chunk documents.
- **Debounced Search Bar (250ms)**:
  - Input field updates locally for zero-latency keystroke response, while the database query is debounced by 250ms to prevent expensive queries during typing.
- **Memoized Card Components**:
  - `EvidenceCard` is wrapped in `React.memo` paired with memoized (`useCallback`) event handlers, ensuring cards never re-render when typing into search or interacting with unrelated UI controls.

---

## 7. State-of-the-Art Infinite Virtualization, Worker Search & Streamed Media Packaging

- **Windowed Infinite Virtualization with Dynamic Row Measurement**:
  - Integrated `@tanstack/react-virtual` using dynamic row measurement (`ref={virtualizer.measureElement}` and `data-index={virtualRow.index}`) so variable-length transcripts, open quote badges, and custom tags never jitter, overlap, or clip.
  - Implemented an IndexedDB cursor-driven sliding memory window (`WINDOW_SIZE = 150`, prefetch threshold 25) that retains only 100–150 chunk objects in React state regardless of whether the vault holds 100 or 118,500 records, ensuring flat memory consumption and 60–120 FPS scrolling with zero DOM bloat.
  - Provided dynamic skeleton placeholders during rapid cursor seek jumps and a floating quick-return scroll-to-top control.

- **Web Worker-Offloaded Full-Text Search (FlexSearch)**:
  - Offloaded full-text indexing and query execution to a dedicated Web Worker (`src/workers/search.worker.ts`) using FlexSearch Document indexing across `speaker`, `coordinate`, `text`, `summary`, `source_title`, `entities`, and `tags`.
  - Wired the 250ms debounced search bar to query the worker thread asynchronously via `useSearchWorker`, returning ranked match ID arrays in sub-10ms without ever stuttering or locking the main UI thread.
  - Real-time search badge provides live visibility into worker execution latency (`Worker match in Xms`).

- **Streamed Documentary Dossier Builder & Media Packaging**:
  - Replaced monolithic file strings with zero-lag streaming serialization via `ReadableStream<Uint8Array>` and chunked stream writers (`src/utils/streamingExport.ts`). Uses modern File System Access API (`window.showSaveFilePicker`) with high-efficiency chunked Blob streaming fallback for browser downloads.
  - **Structured Evidence Briefs (.md)**: Streams comprehensive documentary dossiers organized by Named Entities with verbatim citation pills, analytical summaries, provenance metadata, and classification breakdowns (Verified Records vs Contested Claims vs Statements).
  - **NLE Cut Lists (CMX 3600 EDL)**: Formats professional Edit Decision Lists (`.edl`) compliant with CMX 3600 standard for Adobe Premiere Pro, DaVinci Resolve, Apple Final Cut Pro, and Avid Media Composer. Automatically computes 24/25/30 fps SMPTE timecodes (`HH:MM:SS:FF`), reel IDs, cut transitions, and soundbite metadata comments.
  - **Streamed Corpus (.jsonl)**: Direct chunked streaming of the complete IndexedDB corpus without memory spikes.
  - Dedicated `ExportModal` offers format selection, source/classification scoping, timecode FPS settings, and a live progress meter tracking chunks processed in real time.

- **Scrollbar Track Mini-Indicators & Result Cluster Navigation**:
  - Implemented an interactive scrollbar track overlay on the virtualized feed displaying glowing mini-indicators (amber pips for individual matches and circular count badges for multi-match clusters) mapped to the exact vertical timeline positions across the corpus.
  - Added intelligent cluster grouping (merging search hits within 2.5% of list height into density clusters) to highlight focal points in witness testimony or documentary evidence.
  - Clicking any indicator or cluster smoothly scrolls the virtual list directly to that result cluster (`virtualizer.scrollToIndex`), pre-fetching the sliding memory window for zero delay, and applying a pulsing amber highlight ring (`isJumpTarget`) to the target card.
  - Hovering displays a floating tooltip preview indicating row range, cluster count, and jumping prompt.
  - Added sequential cluster navigation buttons (`▲ Prev` / `▼ Next` with keyboard shortcuts `F3` / `Shift+F3`) and a dual-mode view toggle (`Context Timeline` vs `Matches Only`).




