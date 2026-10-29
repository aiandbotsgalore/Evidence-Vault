export type SourceType =
  | 'archival_audio'
  | 'court_filing'
  | 'witness_interview'
  | 'editorial_note';

export type ClassificationType =
  | 'verified_record'
  | 'spoken_statement'
  | 'allegation_or_claim'
  | 'editorial_note';

export interface SourceDocument {
  source_id: string;
  title: string;
  source_type: SourceType;
  default_speaker: string;
  file_name: string;
  ingested_at: string;
  chunk_count: number;
  is_sample?: boolean;
}

export interface RawDeterministicChunk {
  chunk_id: string;
  source_id: string;
  source_title: string;
  source_type: SourceType;
  speaker: string;
  coordinate: string;
  start_ms: number | null;
  end_ms: number | null;
  page_or_section: string | null;
  text: string;
  default_quote_snippet: string;
  default_citation_pill: string;
}

export interface EvidenceChunk {
  chunk_id: string;
  source_id: string;
  source_title: string;
  source_type: SourceType;
  speaker: string;
  coordinate: string;
  start_ms: number | null;
  end_ms: number | null;
  page_or_section: string | null;
  text: string;
  quote_snippet: string;
  citation_pill: string;
  classification: ClassificationType;
  summary: string;
  named_entities: string[];
  custom_tags?: string[];
  is_sample?: boolean;
}

export interface ArgonChunkEnrichment {
  chunk_id: string;
  classification: ClassificationType;
  summary: string;
  named_entities: string[];
  quote_snippet: string;
}

export interface AskVaultResponse {
  query: string;
  synthesis: string;
  matched_chunk_ids: string[];
  key_entities: string[];
  used_model: string;
}
