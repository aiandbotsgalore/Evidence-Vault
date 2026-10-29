import {
  ClassificationType,
  EvidenceChunk,
  RawDeterministicChunk,
  SourceType,
} from '../types';

/**
 * Normalizes curly single/double quotes and whitespace for exact substring comparison.
 */
function normalizeForComparison(str: string): string {
  return str
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts a clean, deterministic verbatim substring from chunk text when
 * no candidate snippet is provided or when a candidate fails verbatim verification.
 */
export function extractDeterministicVerbatimQuote(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  // Split into sentence or clause candidates
  const clauses = cleaned
    .split(/(?<=[.?!;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);

  const chosen = clauses.length > 0 ? clauses[0] : cleaned;

  if (chosen.length <= 85) {
    return chosen.replace(/^["“”']+|[,"“”']+$/g, '').trim();
  }

  // Truncate cleanly on a word boundary within 80 chars so it remains a verbatim substring
  const slice = chosen.slice(0, 80);
  const lastSpace = slice.lastIndexOf(' ');
  const exactSubstring = lastSpace > 24 ? slice.slice(0, lastSpace) : slice;
  return exactSubstring.replace(/^["“”']+|[,"“”']+$/g, '').trim();
}

/**
 * Enforces that `candidateSnippet` is an exact verbatim substring of `chunkText`,
 * and sanitizes any inner double quotes (`"`, `“`, `”`) to single quotes (`'`)
 * so downstream timeline regex parsers (`\[.*? "(.*?)"\]`) never break.
 */
export function validateAndSanitizeQuoteSnippet(
  chunkText: string,
  candidateSnippet?: string
): string {
  const normalizedChunk = normalizeForComparison(chunkText);
  let verifiedSubstring = '';

  if (candidateSnippet && candidateSnippet.trim().length >= 5) {
    const trimmedCandidate = candidateSnippet
      .replace(/^["“”']+|["“”']+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedCandidate = normalizeForComparison(trimmedCandidate);

    if (
      normalizedCandidate.length >= 5 &&
      normalizedChunk.toLowerCase().includes(normalizedCandidate.toLowerCase())
    ) {
      // Find the exact case-preserving substring inside normalizedChunk
      const idx = normalizedChunk
        .toLowerCase()
        .indexOf(normalizedCandidate.toLowerCase());
      verifiedSubstring = normalizedChunk.slice(
        idx,
        idx + normalizedCandidate.length
      );
    }
  }

  if (!verifiedSubstring) {
    verifiedSubstring = extractDeterministicVerbatimQuote(chunkText);
  }

  // Strictly replace any inner double quotes with single quotes for regex safety
  const sanitized = verifiedSubstring
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized;
}

/**
 * Formats the exact citation pill required by the documentary timeline editor:
 * `[Speaker/Source Coordinate "Quote snippet"]`
 * e.g. `[Eric Hecker 2:02:15 "who do you think the scumbags are?"]`
 * or `[Doc: Filing p. 4 "The petition was entered..."]`
 */
export function buildCitationPill(
  speakerOrSource: string,
  coordinate: string,
  chunkText: string,
  candidateSnippet?: string
): { quote_snippet: string; citation_pill: string } {
  const cleanSpeaker = speakerOrSource.replace(/[\[\]"]/g, '').trim() || 'Source';
  const cleanCoord = coordinate.replace(/[\[\]"]/g, '').trim() || 'p. 1';
  const quote_snippet = validateAndSanitizeQuoteSnippet(
    chunkText,
    candidateSnippet
  );

  const citation_pill = `[${cleanSpeaker} ${cleanCoord} "${quote_snippet}"]`;
  return { quote_snippet, citation_pill };
}

/**
 * Parses a timestamp string (`HH:MM:SS.mmm`, `HH:MM:SS,mmm`, `MM:SS.mmm`, `MM:SS,mmm`, or `HH:MM:SS`)
 * into exact milliseconds.
 */
export function parseTimestampToMs(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\[|\]$/g, '');
  // Match H:MM:SS(.mmm) or MM:SS(.mmm) with either dot or comma millisecond separator
  const match = cleaned.match(
    /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/
  );
  if (!match) {
    // Also check pure seconds like "142.5s" or "142.5"
    const secMatch = cleaned.match(/^(\d+(?:\.\d+)?)s?$/i);
    if (secMatch) {
      return Math.round(parseFloat(secMatch[1]) * 1000);
    }
    return null;
  }

  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const msRaw = match[4] ? match[4].padEnd(3, '0').slice(0, 3) : '000';
  const ms = parseInt(msRaw, 10);

  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + ms;
}

/**
 * Formats milliseconds into human-readable timeline coordinate:
 * e.g. `2:02:15` (if >= 1 hr) or `14:08` (if < 1 hr).
 */
export function formatMsToCoordinate(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad2 = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${minutes}:${pad2(seconds)}`;
}

/**
 * Formats milliseconds into exact SMPTE/millisecond display `HH:MM:SS.mmm`
 */
export function formatMsExact(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const millis = safe % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad2 = (n: number) => n.toString().padStart(2, '0');
  const pad3 = (n: number) => n.toString().padStart(3, '0');
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(millis)}`;
}

/**
 * Extracts and strips speaker prefixes from a transcript line:
 * - WebVTT `<v Speaker Name>Text</v>` or `<v.loud Speaker Name>Text`
 * - Bracketed `[Speaker Name]: Text` or `[Speaker Name] Text`
 * - Standard `Speaker Name: Text`
 */
export function extractSpeakerAndCleanText(
  rawLine: string,
  currentSpeaker: string
): { speaker: string; text: string } {
  let line = rawLine.trim();

  // 1. WebVTT <v ...> voice tag: `<v Speaker Name>Text</v>` or `<v.class Speaker Name>Text`
  const vttVoiceMatch = line.match(
    /^<v(?:\.[a-zA-Z0-9_-]+)*\s+([^>]+)>(.*?)(?:<\/v>)?$/i
  );
  if (vttVoiceMatch) {
    const speaker = vttVoiceMatch[1].trim() || currentSpeaker;
    const text = vttVoiceMatch[2].replace(/<\/?[^>]+>/g, '').trim();
    return { speaker, text };
  }

  // Strip any stray inline HTML/VTT tags like <c.color>, <i>, </v>
  line = line.replace(/<\/?(?:c|i|b|u|v|ruby|rt)(?:\.[^>\s]+)?[^>]*>/gi, '').trim();

  // 2. Bracketed speaker tag `[Speaker Name]: text`
  const bracketSpeakerMatch = line.match(
    /^\[([A-Za-z0-9\s.'\-_]{2,35})\]:?\s+(.+)$/
  );
  if (bracketSpeakerMatch && parseTimestampToMs(bracketSpeakerMatch[1]) === null) {
    return {
      speaker: bracketSpeakerMatch[1].trim(),
      text: bracketSpeakerMatch[2].trim(),
    };
  }

  // 3. Colon speaker prefix `Speaker Name: text` (avoiding URLs or timestamps)
  const colonSpeakerMatch = line.match(
    /^([A-Z][A-Za-z0-9\s.'\-]{1,32}):\s+(.+)$/
  );
  if (colonSpeakerMatch) {
    const candidate = colonSpeakerMatch[1].trim();
    const lower = candidate.toLowerCase();
    if (
      !lower.startsWith('http') &&
      !lower.startsWith('note') &&
      !lower.startsWith('page') &&
      !lower.startsWith('exhibit')
    ) {
      return {
        speaker: candidate,
        text: colonSpeakerMatch[2].trim(),
      };
    }
  }

  return { speaker: currentSpeaker, text: line };
}

interface ParsedCue {
  start_ms: number;
  end_ms: number;
  speaker: string;
  text: string;
}

/**
 * Detects whether a file is an Audio Clip Catalog text file
 * (e.g., `Angela_Combined_Quotes_Deduped.txt`) containing `#001 filename.wav` or
 * `---` blocks with `SPEAKER:`, `TIMESTAMP:`, `SOURCE:`, `QUOTE:`, `FILE:` fields.
 */
export function detectIsAudioClipCatalog(content: string): boolean {
  if (!content) return false;
  const hasEntryMarkers = /^\s*#\d+\s+\S+/m.test(content);
  const hasSpeakerField = /^\s*SPEAKER\s*:/im.test(content);
  const hasQuoteField = /^\s*QUOTE\s*:/im.test(content);
  const hasTimestampOrFileField =
    /^\s*(?:TIMESTAMP|SOURCE|FILE)\s*:/im.test(content);

  return (
    (hasEntryMarkers && (hasQuoteField || hasSpeakerField)) ||
    (hasSpeakerField && hasQuoteField && hasTimestampOrFileField)
  );
}

/**
 * Deterministically parses an Audio Clip Catalog file where each `#NNN` entry
 * (or `---` separated record containing `QUOTE:`) is treated as a single chunk.
 *
 * - Extracts `speaker` from `SPEAKER:` (if "Not specified", unknown, or blank, falls back to `defaultSpeaker`).
 * - Extracts `coordinate` directly from `TIMESTAMP:` (e.g., `00:37`, `12:51:21`).
 * - Extracts `text` and `quote_snippet` from `QUOTE:`.
 * - Formats the citation pill as `[Speaker Timestamp "Quote"]`.
 */
export function parseAudioClipCatalogDeterministically(
  content: string,
  sourceId: string,
  sourceTitle: string,
  sourceType: SourceType,
  defaultSpeaker: string
): RawDeterministicChunk[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  interface RawClipEntry {
    entryNumber: string;
    headerFile: string;
    speaker: string;
    timestamp: string;
    source: string;
    quoteLines: string[];
    file: string;
  }

  const entries: RawClipEntry[] = [];
  let current: RawClipEntry | null = null;
  let activeField: 'quote' | 'other' | null = null;

  // Match entry header like `#001 filename.wav` or `#193 clip_name.mp3`
  const entryHeaderRegex = /^\s*#(\d+)\b\s*(.*)$/;
  const dividerRegex = /^\s*-{10,}\s*$/;

  const commitCurrent = () => {
    if (!current) return;
    const quoteText = current.quoteLines.join(' ').replace(/\s+/g, ' ').trim();
    if (quoteText || current.speaker || current.timestamp) {
      entries.push(current);
    }
    current = null;
    activeField = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    const headerMatch = trimmed.match(entryHeaderRegex);
    if (headerMatch) {
      commitCurrent();
      current = {
        entryNumber: headerMatch[1].trim(),
        headerFile: headerMatch[2].trim(),
        speaker: '',
        timestamp: '',
        source: '',
        quoteLines: [],
        file: '',
      };
      activeField = null;
      continue;
    }

    if (dividerRegex.test(trimmed)) {
      activeField = null;
      continue;
    }

    // Support files that might start a block with SPEAKER: without a `#001` line
    if (!current && /^\s*SPEAKER\s*:/i.test(trimmed)) {
      current = {
        entryNumber: String(entries.length + 1).padStart(3, '0'),
        headerFile: '',
        speaker: '',
        timestamp: '',
        source: '',
        quoteLines: [],
        file: '',
      };
    }

    if (!current) continue;

    const speakerMatch = trimmed.match(/^SPEAKER\s*:\s*(.*)$/i);
    if (speakerMatch) {
      // If current already had a quote and we encounter a brand new SPEAKER: without a `#` header, start a new entry
      if (current.quoteLines.length > 0 && current.speaker) {
        commitCurrent();
        current = {
          entryNumber: String(entries.length + 1).padStart(3, '0'),
          headerFile: '',
          speaker: speakerMatch[1].trim(),
          timestamp: '',
          source: '',
          quoteLines: [],
          file: '',
        };
      } else {
        current.speaker = speakerMatch[1].trim();
      }
      activeField = 'other';
      continue;
    }

    const timestampMatch = trimmed.match(/^TIMESTAMP\s*:\s*(.*)$/i);
    if (timestampMatch) {
      current.timestamp = timestampMatch[1].trim();
      activeField = 'other';
      continue;
    }

    const sourceMatch = trimmed.match(/^SOURCE\s*:\s*(.*)$/i);
    if (sourceMatch) {
      current.source = sourceMatch[1].trim();
      activeField = 'other';
      continue;
    }

    const fileMatch = trimmed.match(/^FILE\s*:\s*(.*)$/i);
    if (fileMatch) {
      current.file = fileMatch[1].trim();
      activeField = 'other';
      continue;
    }

    const quoteMatch = trimmed.match(/^QUOTE\s*:\s*(.*)$/i);
    if (quoteMatch) {
      const firstLine = quoteMatch[1].trim();
      if (firstLine) {
        current.quoteLines.push(firstLine);
      }
      activeField = 'quote';
      continue;
    }

    // Multi-line quote continuation (until next field or divider or # entry)
    if (activeField === 'quote' && trimmed) {
      current.quoteLines.push(trimmed);
    }
  }

  commitCurrent();

  // Determine fallback speaker if an entry says "Not specified"
  const fallbackSpeaker = defaultSpeaker.trim() || 'Speaker';

  return entries
    .map((entry, idx): RawDeterministicChunk | null => {
      const rawQuote = entry.quoteLines
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/^["“”]+|["“”]+$/g, '')
        .trim();

      if (!rawQuote) return null;

      // Resolve speaker: if "Not specified", "Unknown", "N/A", or empty, use defaultSpeaker
      let resolvedSpeaker = entry.speaker.trim();
      if (
        !resolvedSpeaker ||
        /^(?:not\s+specified|unspecified|unknown|n\/a|none|-+)$/i.test(
          resolvedSpeaker
        )
      ) {
        resolvedSpeaker = fallbackSpeaker;
      }

      // Resolve timestamp coordinate directly from TIMESTAMP:
      let resolvedCoordinate = entry.timestamp.trim();
      // If TIMESTAMP contains a range like `00:37 - 01:12` or `00:37 (37s)`, extract primary timestamp or keep clean
      const rangeSplit = resolvedCoordinate.split(/\s*(?:-->|–|—|\bto\b)\s*/i);
      if (rangeSplit.length > 1 && rangeSplit[0].trim()) {
        resolvedCoordinate = rangeSplit[0].trim();
      }
      if (
        !resolvedCoordinate ||
        /^(?:not\s+specified|unspecified|unknown|n\/a|none|-+)$/i.test(
          resolvedCoordinate
        )
      ) {
        resolvedCoordinate = `#${entry.entryNumber || String(idx + 1).padStart(3, '0')}`;
      }

      const startMs = parseTimestampToMs(resolvedCoordinate);
      const endMs = startMs !== null ? startMs + 15000 : null;

      const chunkId = `chk_${sourceId}_${entry.entryNumber.padStart(3, '0')}`;

      // Build citation pill `[Speaker Timestamp "Quote"]` with inner double quotes sanitized to single quotes
      const { quote_snippet, citation_pill } = buildCitationPill(
        resolvedSpeaker,
        resolvedCoordinate,
        rawQuote,
        rawQuote
      );

      // Preserve clip provenance (`#001`, `SOURCE:`, `FILE:`) in page_or_section metadata
      const provenanceParts: string[] = [];
      if (entry.entryNumber) {
        provenanceParts.push(`#${entry.entryNumber}`);
      }
      if (entry.timestamp) {
        provenanceParts.push(entry.timestamp);
      }
      if (entry.source) {
        provenanceParts.push(entry.source);
      }
      if (entry.file || entry.headerFile) {
        provenanceParts.push(entry.file || entry.headerFile);
      }

      return {
        chunk_id: chunkId,
        source_id: sourceId,
        source_title: entry.source ? `${sourceTitle} (${entry.source})` : sourceTitle,
        source_type: sourceType,
        speaker: resolvedSpeaker,
        coordinate: resolvedCoordinate,
        start_ms: startMs,
        end_ms: endMs,
        page_or_section:
          provenanceParts.join(' · ') || resolvedCoordinate,
        text: rawQuote,
        default_quote_snippet: quote_snippet,
        default_citation_pill: citation_pill,
      };
    })
    .filter((item): item is RawDeterministicChunk => item !== null);
}

/**
 * Detects whether a file is a timestamped transcript (WebVTT, SRT, or timestamped lines)
 * vs. a written document (Markdown, legal filing, field notes).
 */
export function detectIsTranscript(
  fileName: string,
  content: string,
  sourceType?: SourceType
): boolean {
  if (detectIsAudioClipCatalog(content)) {
    return false;
  }
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.vtt') || lowerName.endsWith('.srt')) {
    return true;
  }
  if (/^WEBVTT/im.test(content)) {
    return true;
  }
  // Check for VTT/SRT arrow timestamps with either . or , for milliseconds
  const arrowRegex =
    /(?:(\d{1,2}):)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(?:(\d{1,2}):)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?/m;
  if (arrowRegex.test(content)) {
    return true;
  }
  // Check for at least 2 lines starting with [HH:MM:SS] or HH:MM:SS timestamps
  const lineTsMatches = content.match(
    /^\s*\[?(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\]?\s+/gm
  );
  if (lineTsMatches && lineTsMatches.length >= 2) {
    return true;
  }
  if (sourceType === 'archival_audio' || sourceType === 'witness_interview') {
    if (lineTsMatches && lineTsMatches.length >= 1) return true;
  }
  return false;
}

/**
 * Deterministically parses VTT, SRT, or plain timestamped transcripts into
 * 30–60 second semantic segments or speaker turns, preserving exact millisecond timestamps.
 */
export function parseTranscriptDeterministically(
  content: string,
  sourceId: string,
  sourceTitle: string,
  sourceType: SourceType,
  defaultSpeaker: string
): RawDeterministicChunk[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const cues: ParsedCue[] = [];
  let activeSpeaker = defaultSpeaker.trim() || 'Speaker';

  // Pattern A: VTT / SRT blocks with `-->` arrow lines (handles both `.` and `,` ms formats)
  const arrowLineRegex =
    /^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

  const lines = normalized.split('\n');
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i].trim();

    // Skip WEBVTT header, NOTE blocks, or pure numeric SRT cue counters
    if (
      !rawLine ||
      rawLine.startsWith('WEBVTT') ||
      rawLine.startsWith('NOTE') ||
      /^\d+$/.test(rawLine)
    ) {
      i++;
      continue;
    }

    const arrowMatch = rawLine.match(arrowLineRegex);
    if (arrowMatch) {
      const startMs = parseTimestampToMs(arrowMatch[1]) ?? 0;
      const endMs = parseTimestampToMs(arrowMatch[2]) ?? startMs + 4000;
      i++;

      const cueLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        // Stop if next line is unexpectedly another timestamp arrow
        if (arrowLineRegex.test(lines[i].trim())) break;
        cueLines.push(lines[i].trim());
        i++;
      }

      const combinedCueText = cueLines.join(' ').trim();
      if (combinedCueText) {
        const extracted = extractSpeakerAndCleanText(
          combinedCueText,
          activeSpeaker
        );
        activeSpeaker = extracted.speaker;
        if (extracted.text) {
          cues.push({
            start_ms: startMs,
            end_ms: Math.max(startMs + 500, endMs),
            speaker: activeSpeaker,
            text: extracted.text,
          });
        }
      }
      continue;
    }

    // Pattern B: Inline timestamped transcript lines:
    // e.g. `[02:02:15] Eric Hecker: who do you think...` or `02:02:15.250 Speaker: text`
    const inlineMatch = rawLine.match(
      /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*(?:-\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?)?\s+(.+)$/
    );
    if (inlineMatch) {
      const startMs = parseTimestampToMs(inlineMatch[1]) ?? 0;
      const explicitEndMs = inlineMatch[2]
        ? parseTimestampToMs(inlineMatch[2])
        : null;
      const restText = inlineMatch[3].trim();

      const extracted = extractSpeakerAndCleanText(restText, activeSpeaker);
      activeSpeaker = extracted.speaker;

      if (extracted.text) {
        cues.push({
          start_ms: startMs,
          end_ms: explicitEndMs ?? startMs + 10000,
          speaker: activeSpeaker,
          text: extracted.text,
        });
      }
      i++;
      continue;
    }

    // Continuation line for the previous cue if present
    if (cues.length > 0) {
      const extracted = extractSpeakerAndCleanText(rawLine, activeSpeaker);
      if (extracted.speaker !== activeSpeaker) {
        activeSpeaker = extracted.speaker;
        const prevEnd = cues[cues.length - 1].end_ms;
        cues.push({
          start_ms: prevEnd,
          end_ms: prevEnd + 8000,
          speaker: activeSpeaker,
          text: extracted.text,
        });
      } else if (extracted.text) {
        cues[cues.length - 1].text += ' ' + extracted.text;
      }
    }
    i++;
  }

  // Adjust synthetic end_ms on inline cues so they don't overlap the next cue's start_ms
  for (let c = 0; c < cues.length - 1; c++) {
    if (cues[c].end_ms > cues[c + 1].start_ms && cues[c + 1].start_ms > cues[c].start_ms) {
      cues[c].end_ms = cues[c + 1].start_ms;
    }
  }

  // Group cues into 30–60 second semantic segments or speaker turns
  const groupedSegments: ParsedCue[] = [];
  const TARGET_MIN_MS = 30_000;
  const TARGET_MAX_MS = 60_000;

  for (const cue of cues) {
    if (groupedSegments.length === 0) {
      groupedSegments.push({ ...cue });
      continue;
    }

    const current = groupedSegments[groupedSegments.length - 1];
    const currentDuration = current.end_ms - current.start_ms;
    const wouldBeDuration = cue.end_ms - current.start_ms;
    const sameSpeaker =
      current.speaker.toLowerCase() === cue.speaker.toLowerCase();

    // Split on speaker turn change (unless current turn is tiny < 4s and same speaker wasn't explicit)
    // OR when duration exceeds the 30-60s window
    const shouldMerge =
      sameSpeaker &&
      wouldBeDuration <= TARGET_MAX_MS &&
      (currentDuration < TARGET_MIN_MS || current.text.length < 260);

    if (shouldMerge) {
      current.end_ms = Math.max(current.end_ms, cue.end_ms);
      current.text = `${current.text} ${cue.text}`.replace(/\s+/g, ' ').trim();
    } else {
      groupedSegments.push({ ...cue });
    }
  }

  return groupedSegments.map((seg, idx) => {
    const chunkId = `chk_${sourceId}_${String(idx + 1).padStart(3, '0')}`;
    const coordinate = formatMsToCoordinate(seg.start_ms);
    const { quote_snippet, citation_pill } = buildCitationPill(
      seg.speaker,
      coordinate,
      seg.text
    );

    return {
      chunk_id: chunkId,
      source_id: sourceId,
      source_title: sourceTitle,
      source_type: sourceType,
      speaker: seg.speaker,
      coordinate,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      page_or_section: `${formatMsExact(seg.start_ms)} – ${formatMsExact(seg.end_ms)}`,
      text: seg.text,
      default_quote_snippet: quote_snippet,
      default_citation_pill: citation_pill,
    };
  });
}

/**
 * Deterministically partitions written records (Markdown, TXT, court filings, field notes)
 * by Markdown headers, numbered legal clauses, page markers, or double linebreaks.
 */
export function parseDocumentDeterministically(
  content: string,
  sourceId: string,
  sourceTitle: string,
  sourceType: SourceType,
  defaultSpeaker: string
): RawDeterministicChunk[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return [];

  // Split by double newlines or before markdown headers / explicit page indicators
  const rawBlocks = normalized
    .split(/\n{2,}|(?=\n^#{1,4}\s+)/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: RawDeterministicChunk[] = [];
  let currentPage = 'p. 1';
  let currentSection = '';
  let paragraphCounter = 0;

  // Determine citation prefix: for court filings or documents, use Default Speaker if provided or Source Title
  const citationPrefix =
    defaultSpeaker.trim() ||
    (sourceTitle.toLowerCase().startsWith('doc:')
      ? sourceTitle.trim()
      : `Doc: ${sourceTitle.trim()}`);

  let pendingHeader = '';

  for (let i = 0; i < rawBlocks.length; i++) {
    let block = rawBlocks[i];

    // Check for standalone page marker e.g. `[Page 4]`, `--- Page 4 ---`, `PAGE 4`, `p. 4`
    const pageMarkerMatch = block.match(
      /(?:^|\b)(?:page|p\.|pg\.)\s*(\d+)(?:\b|$)/i
    );
    if (pageMarkerMatch) {
      currentPage = `p. ${pageMarkerMatch[1]}`;
      // If the block is ONLY a page marker, continue to next block
      if (
        block.replace(/[\[\]\-—_*(?:page|p\.|pg\.)\s\d+]/gi, '').trim()
          .length === 0
      ) {
        continue;
      }
    }

    // Check for Markdown header `# Section`
    const headerMatch = block.match(/^(#{1,4})\s+(.+)$/);
    if (headerMatch && !block.includes('\n')) {
      currentSection = headerMatch[2].trim();
      pendingHeader = currentSection;
      continue;
    }

    // If block starts with a header and has body text on subsequent lines
    const multiLineHeaderMatch = block.match(/^(#{1,4})\s+([^\n]+)\n+([\s\S]+)$/);
    if (multiLineHeaderMatch) {
      currentSection = multiLineHeaderMatch[2].trim();
      block = multiLineHeaderMatch[3].trim();
    } else if (pendingHeader) {
      pendingHeader = '';
    }

    // Detect legal clause numbering at start of paragraph: e.g. `14.`, `§ 4.2`, `Article III`
    let coordinate = currentPage;
    const clauseMatch = block.match(
      /^(?:(§+\s*\d+(?:\.\d+)*)|(\d{1,3}\.\d+(?:\.\d+)*)|(\[\d+\]))\s+/
    );

    paragraphCounter++;
    if (clauseMatch) {
      const clauseRef = (clauseMatch[1] || clauseMatch[2] || clauseMatch[3]).trim();
      coordinate = currentPage !== 'p. 1' ? `${currentPage}, ${clauseRef}` : clauseRef;
    } else if (pageMarkerMatch) {
      coordinate = `p. ${pageMarkerMatch[1]}`;
    } else if (currentPage === 'p. 1' && rawBlocks.length > 1) {
      coordinate = `¶ ${paragraphCounter}`;
    }

    // Strip inline `[Page X]` tags from the clean body text while keeping prose intact
    const cleanText = block
      .replace(/^\[?(?:page|p\.|pg\.)\s*\d+\]?\s*:?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanText || cleanText.length < 8) continue;

    // Check if the paragraph itself has an explicit speaker prefix (e.g. Q: / A: or Witness:)
    let chunkSpeaker = citationPrefix;
    let finalBody = cleanText;
    if (sourceType === 'witness_interview') {
      const extracted = extractSpeakerAndCleanText(cleanText, citationPrefix);
      chunkSpeaker = extracted.speaker;
      finalBody = extracted.text;
    }

    const chunkId = `chk_${sourceId}_${String(chunks.length + 1).padStart(3, '0')}`;
    const { quote_snippet, citation_pill } = buildCitationPill(
      chunkSpeaker,
      coordinate,
      finalBody
    );

    chunks.push({
      chunk_id: chunkId,
      source_id: sourceId,
      source_title: sourceTitle,
      source_type: sourceType,
      speaker: chunkSpeaker,
      coordinate,
      start_ms: null,
      end_ms: null,
      page_or_section: currentSection
        ? `${coordinate} · ${currentSection}`
        : coordinate,
      text: finalBody,
      default_quote_snippet: quote_snippet,
      default_citation_pill: citation_pill,
    });
  }

  return chunks;
}

/**
 * Deterministic local fallback classifier when Gemini API is unreachable or key is declined.
 */
export function deterministicFallbackClassify(
  chunk: RawDeterministicChunk
): Pick<EvidenceChunk, 'classification' | 'summary' | 'named_entities'> {
  const lower = chunk.text.toLowerCase();
  let classification: ClassificationType = 'spoken_statement';

  if (
    chunk.source_type === 'editorial_note' ||
    lower.includes('todo:') ||
    lower.includes('editorial note') ||
    lower.includes('verify ') ||
    lower.includes('cross-check')
  ) {
    classification = 'editorial_note';
  } else if (
    chunk.source_type === 'court_filing' ||
    /\b(exhibit|docket|petition|stipulated|entered|pursuant|contract|invoice|deposition|affidavit)\b/i.test(
      chunk.text
    )
  ) {
    classification = 'verified_record';
  } else if (
    /\b(alleged|accused|claimed|cover-up|secret|conspiracy|scumbags|bribe|illegal|rigged|weapon|directed energy)\b/i.test(
      chunk.text
    )
  ) {
    classification = 'allegation_or_claim';
  } else {
    classification = 'spoken_statement';
  }

  // Extract capitalized multi-word proper nouns as fallback named entities
  const entityMatches: string[] =
    chunk.text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-zA-Z0-9.]+){0,2})\b/g) || [];
  const stopWords = new Set<string>([
    'The',
    'This',
    'That',
    'When',
    'Where',
    'What',
    'Who',
    'Why',
    'How',
    'And',
    'But',
    'For',
    'Nor',
    'Yet',
    'So',
    'In',
    'On',
    'At',
    'To',
    'From',
    'By',
    'With',
    'Upon',
    'During',
    'Before',
    'After',
    'Section',
    'Page',
    'Article',
  ]);
  const entities = Array.from(
    new Set(
      entityMatches
        .map((e: string) => e.trim())
        .filter((e: string) => e.length > 2 && !stopWords.has(e))
    )
  ).slice(0, 5);

  const firstSentence =
    chunk.text.split(/(?<=[.?!])\s+/)[0]?.slice(0, 140) || chunk.text.slice(0, 120);
  const summary = `${chunk.speaker} (${chunk.coordinate}): ${firstSentence}`;

  return {
    classification,
    summary,
    named_entities: entities.length > 0 ? entities : [chunk.speaker],
  };
}
