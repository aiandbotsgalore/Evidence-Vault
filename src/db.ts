import Dexie, { type Table, type Collection } from 'dexie';
import { ClassificationType, EvidenceChunk, SourceDocument } from './types';

export class EvidenceVaultDB extends Dexie {
  sources!: Table<SourceDocument, string>;
  chunks!: Table<EvidenceChunk, string>;

  constructor() {
    super('EvidenceVaultDB');
    this.version(1).stores({
      sources: 'source_id, title, source_type, is_sample',
      chunks:
        'chunk_id, source_id, speaker, coordinate, classification, is_sample, *named_entities',
    });
    this.version(2).stores({
      sources: 'source_id, title, source_type, is_sample',
      chunks:
        'chunk_id, source_id, speaker, coordinate, classification, is_sample, *named_entities, *custom_tags',
    });
    this.version(3).stores({
      sources: 'source_id, title, source_type, is_sample',
      chunks:
        'chunk_id, source_id, speaker, coordinate, classification, [source_id+classification], is_sample, *named_entities, *custom_tags',
    });
  }
}

export const db = new EvidenceVaultDB();

/**
 * Normalizes custom tag format to standard `#tag-name` (e.g. `witness` -> `#witness`).
 */
export function normalizeTag(rawTag: string): string {
  let cleaned = rawTag.trim().toLowerCase();
  if (!cleaned.startsWith('#')) {
    cleaned = '#' + cleaned;
  }
  // Sanitize characters to alphanumeric and dashes/underscores
  const prefix = '#';
  const body = cleaned
    .slice(1)
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return body ? `${prefix}${body}` : '';
}

/**
 * Adds a custom metadata tag to a specific chunk in IndexedDB.
 */
export async function addCustomTagToChunk(
  chunkId: string,
  rawTag: string
): Promise<string[]> {
  const tag = normalizeTag(rawTag);
  if (!tag) return [];

  const chunk = await db.chunks.get(chunkId);
  if (!chunk) return [];

  const existingTags = Array.isArray(chunk.custom_tags)
    ? [...chunk.custom_tags]
    : [];
  if (!existingTags.includes(tag)) {
    existingTags.push(tag);
    await db.chunks.update(chunkId, { custom_tags: existingTags });
  }

  return existingTags;
}

/**
 * Removes a custom metadata tag from a specific chunk in IndexedDB.
 */
export async function removeCustomTagFromChunk(
  chunkId: string,
  rawTag: string
): Promise<string[]> {
  const tag = normalizeTag(rawTag);
  const chunk = await db.chunks.get(chunkId);
  if (!chunk || !Array.isArray(chunk.custom_tags)) return [];

  const updatedTags = chunk.custom_tags.filter((t) => t !== tag);
  await db.chunks.update(chunkId, { custom_tags: updatedTags });
  return updatedTags;
}

/**
 * Retrieves all unique custom metadata tags across the entire vault with their chunk counts
 * using Dexie multi-entry index keys without loading chunk document payloads.
 */
export async function getAllCustomTagsWithCounts(): Promise<
  { tag: string; count: number }[]
> {
  const counts = new Map<string, number>();

  try {
    await db.chunks.orderBy('custom_tags').eachKey((tagKey) => {
      const tag = String(tagKey);
      if (tag) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    });
  } catch {
    // Fallback if orderBy cursor encounters an unindexed legacy state
    const chunks = await db.chunks.toArray();
    for (const c of chunks) {
      if (Array.isArray(c.custom_tags)) {
        for (const t of c.custom_tags) {
          if (t) {
            counts.set(t, (counts.get(t) || 0) + 1);
          }
        }
      }
    }
  }

  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface QueryVaultOptions {
  sourceId?: string; // 'all' or specific source_id
  classification?: ClassificationType | 'all';
  tag?: string | null;
  searchQuery?: string;
  matchedChunkIds?: string[] | null;
  page?: number; // 1-indexed
  pageSize?: number; // defaults to 30
}

export interface QueryVaultResult {
  chunks: EvidenceChunk[];
  totalFilteredCount: number;
}

/**
 * Executes an optimized IndexedDB query via Dexie:
 * 1. Offloads source, classification, and tag indexing directly to Dexie indexes.
 * 2. Offloads counting to Dexie .count() without deserializing non-visible items.
 * 3. Applies .offset() and .limit(pageSize) to return strictly the active 30-card slice for rendering.
 */
export async function queryVaultChunks(
  options: QueryVaultOptions
): Promise<QueryVaultResult> {
  const {
    sourceId = 'all',
    classification = 'all',
    tag = null,
    searchQuery = '',
    matchedChunkIds = null,
    page = 1,
    pageSize = 30,
  } = options;

  let collection: Collection<EvidenceChunk, string>;

  // 1. Leverage the most selective Dexie compound or single index
  if (sourceId !== 'all' && classification !== 'all') {
    collection = db.chunks
      .where('[source_id+classification]')
      .equals([sourceId, classification]);
  } else if (sourceId !== 'all') {
    collection = db.chunks.where('source_id').equals(sourceId);
  } else if (classification !== 'all') {
    collection = db.chunks.where('classification').equals(classification);
  } else if (tag) {
    collection = db.chunks.where('custom_tags').equals(tag);
  } else {
    collection = db.chunks.toCollection();
  }

  // 2. Secondary in-cursor filtering if tag was not the primary index
  if (tag && (sourceId !== 'all' || classification !== 'all')) {
    collection = collection.filter(
      (c) => Array.isArray(c.custom_tags) && c.custom_tags.includes(tag)
    );
  }

  // If specific Ask Vault matched IDs were provided
  if (matchedChunkIds && matchedChunkIds.length > 0) {
    const idSet = new Set(matchedChunkIds);
    collection = collection.filter((c) => idSet.has(c.chunk_id));
  } else if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    collection = collection.filter((chunk) => {
      if (chunk.speaker?.toLowerCase().includes(q)) return true;
      if (chunk.coordinate?.toLowerCase().includes(q)) return true;
      if (chunk.citation_pill?.toLowerCase().includes(q)) return true;
      if (chunk.summary?.toLowerCase().includes(q)) return true;
      if (chunk.text?.toLowerCase().includes(q)) return true;
      if (chunk.source_title?.toLowerCase().includes(q)) return true;
      if (
        Array.isArray(chunk.named_entities) &&
        chunk.named_entities.some((e) => e.toLowerCase().includes(q))
      ) {
        return true;
      }
      if (
        Array.isArray(chunk.custom_tags) &&
        chunk.custom_tags.some((t) => t.toLowerCase().includes(q))
      ) {
        return true;
      }
      return false;
    });
  }

  // 3. Exact matching count from IndexedDB
  const totalFilteredCount = await collection.count();

  // 4. Retrieve strictly the requested 30-item slice using IndexedDB offset/limit
  const offset = Math.max(0, (page - 1) * pageSize);
  const chunks = await collection.offset(offset).limit(pageSize).toArray();

  return {
    chunks,
    totalFilteredCount,
  };
}

/**
 * Retrieves the full ordered list of chunk_ids for the active scope (sourceId, classification, tag)
 * using Dexie primaryKeys() without deserializing chunk document payloads into memory.
 */
export async function getOrderedChunkIds(options: {
  sourceId?: string;
  classification?: ClassificationType | 'all';
  tag?: string | null;
}): Promise<string[]> {
  const { sourceId = 'all', classification = 'all', tag = null } = options;
  let collection: Collection<EvidenceChunk, string>;

  if (sourceId !== 'all' && classification !== 'all') {
    collection = db.chunks
      .where('[source_id+classification]')
      .equals([sourceId, classification]);
  } else if (sourceId !== 'all') {
    collection = db.chunks.where('source_id').equals(sourceId);
  } else if (classification !== 'all') {
    collection = db.chunks.where('classification').equals(classification);
  } else if (tag) {
    collection = db.chunks.where('custom_tags').equals(tag);
  } else {
    collection = db.chunks.toCollection();
  }

  if (tag && (sourceId !== 'all' || classification !== 'all')) {
    collection = collection.filter(
      (c) => Array.isArray(c.custom_tags) && c.custom_tags.includes(tag)
    );
  }

  return collection.primaryKeys();
}

/**
 * Computes exact classification counters directly off Dexie indexes without loading chunks into memory.
 */
export async function getClassificationCounts(
  sourceId: string
): Promise<Record<ClassificationType | 'all', number>> {
  if (sourceId === 'all') {
    const [all, verified, spoken, allegation, note] = await Promise.all([
      db.chunks.count(),
      db.chunks.where('classification').equals('verified_record').count(),
      db.chunks.where('classification').equals('spoken_statement').count(),
      db.chunks.where('classification').equals('allegation_or_claim').count(),
      db.chunks.where('classification').equals('editorial_note').count(),
    ]);

    return {
      all,
      verified_record: verified,
      spoken_statement: spoken,
      allegation_or_claim: allegation,
      editorial_note: note,
    };
  } else {
    const [all, verified, spoken, allegation, note] = await Promise.all([
      db.chunks.where('source_id').equals(sourceId).count(),
      db.chunks
        .where('[source_id+classification]')
        .equals([sourceId, 'verified_record'])
        .count(),
      db.chunks
        .where('[source_id+classification]')
        .equals([sourceId, 'spoken_statement'])
        .count(),
      db.chunks
        .where('[source_id+classification]')
        .equals([sourceId, 'allegation_or_claim'])
        .count(),
      db.chunks
        .where('[source_id+classification]')
        .equals([sourceId, 'editorial_note'])
        .count(),
    ]);

    return {
      all,
      verified_record: verified,
      spoken_statement: spoken,
      allegation_or_claim: allegation,
      editorial_note: note,
    };
  }
}
