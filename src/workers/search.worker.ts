import FlexSearch from 'flexsearch';
import type { EvidenceChunk, ClassificationType } from '../types';

export interface SearchWorkerMessage {
  type: 'INIT' | 'ADD' | 'REMOVE_SOURCE' | 'CLEAR' | 'SEARCH';
  payload?: any;
  requestId?: string;
}

export interface SearchWorkerResponse {
  type: 'READY' | 'INDEXED' | 'SEARCH_RESULTS' | 'CLEARED' | 'ERROR';
  requestId?: string;
  matchIds?: string[];
  totalIndexed?: number;
  elapsedMs?: number;
  error?: string;
}

interface IndexedChunkDoc {
  id: string;
  speaker: string;
  coordinate: string;
  text: string;
  summary: string;
  source_title: string;
  source_id: string;
  classification: ClassificationType;
  entities: string;
  tags: string;
}

// In-memory catalog of indexed metadata for secondary filtering within worker
const chunkMetadata = new Map<
  string,
  {
    source_id: string;
    classification: ClassificationType;
    tags: string[];
  }
>();

// FlexSearch Document index configured for fast prefix, token, and keyword matching
let documentIndex: any = null;

function initDocumentIndex() {
  // @ts-expect-error FlexSearch Document types resolution
  const DocumentClass = FlexSearch.Document || FlexSearch.default?.Document || FlexSearch;
  
  documentIndex = new DocumentClass({
    document: {
      id: 'id',
      index: [
        'speaker',
        'coordinate',
        'text',
        'summary',
        'source_title',
        'entities',
        'tags',
      ],
    },
    tokenize: 'forward',
    resolution: 9,
    cache: 100,
  });
}

initDocumentIndex();

self.onmessage = async (e: MessageEvent<SearchWorkerMessage>) => {
  const { type, payload, requestId } = e.data;
  const startTime = performance.now();

  try {
    switch (type) {
      case 'INIT': {
        const chunks: EvidenceChunk[] = payload?.chunks || [];
        initDocumentIndex();
        chunkMetadata.clear();

        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          const doc: IndexedChunkDoc = {
            id: c.chunk_id,
            speaker: c.speaker || '',
            coordinate: c.coordinate || '',
            text: c.text || '',
            summary: c.summary || '',
            source_title: c.source_title || '',
            source_id: c.source_id,
            classification: c.classification,
            entities: Array.isArray(c.named_entities) ? c.named_entities.join(' ') : '',
            tags: Array.isArray(c.custom_tags) ? c.custom_tags.join(' ') : '',
          };
          documentIndex.add(doc);
          chunkMetadata.set(c.chunk_id, {
            source_id: c.source_id,
            classification: c.classification,
            tags: Array.isArray(c.custom_tags) ? c.custom_tags : [],
          });
        }

        const elapsedMs = Math.round(performance.now() - startTime);
        self.postMessage({
          type: 'READY',
          requestId,
          totalIndexed: chunkMetadata.size,
          elapsedMs,
        } as SearchWorkerResponse);
        break;
      }

      case 'ADD': {
        const chunks: EvidenceChunk[] = payload?.chunks || [];
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          const doc: IndexedChunkDoc = {
            id: c.chunk_id,
            speaker: c.speaker || '',
            coordinate: c.coordinate || '',
            text: c.text || '',
            summary: c.summary || '',
            source_title: c.source_title || '',
            source_id: c.source_id,
            classification: c.classification,
            entities: Array.isArray(c.named_entities) ? c.named_entities.join(' ') : '',
            tags: Array.isArray(c.custom_tags) ? c.custom_tags.join(' ') : '',
          };
          documentIndex.add(doc);
          chunkMetadata.set(c.chunk_id, {
            source_id: c.source_id,
            classification: c.classification,
            tags: Array.isArray(c.custom_tags) ? c.custom_tags : [],
          });
        }

        const elapsedMs = Math.round(performance.now() - startTime);
        self.postMessage({
          type: 'INDEXED',
          requestId,
          totalIndexed: chunkMetadata.size,
          elapsedMs,
        } as SearchWorkerResponse);
        break;
      }

      case 'CLEAR': {
        initDocumentIndex();
        chunkMetadata.clear();
        self.postMessage({
          type: 'CLEARED',
          requestId,
          totalIndexed: 0,
        } as SearchWorkerResponse);
        break;
      }

      case 'SEARCH': {
        const query: string = (payload?.query || '').trim();
        const filters = payload?.filters || {};
        const sourceIdFilter = filters.sourceId && filters.sourceId !== 'all' ? filters.sourceId : null;
        const classificationFilter = filters.classification && filters.classification !== 'all' ? filters.classification : null;
        const tagFilter = filters.tag || null;

        if (!query) {
          // If no query, apply only metadata filters if any
          let resultIds: string[] = [];
          for (const [id, meta] of chunkMetadata.entries()) {
            if (sourceIdFilter && meta.source_id !== sourceIdFilter) continue;
            if (classificationFilter && meta.classification !== classificationFilter) continue;
            if (tagFilter && !meta.tags.includes(tagFilter)) continue;
            resultIds.push(id);
          }
          const elapsedMs = Math.round(performance.now() - startTime);
          self.postMessage({
            type: 'SEARCH_RESULTS',
            requestId,
            matchIds: resultIds,
            elapsedMs,
          } as SearchWorkerResponse);
          return;
        }

        // Execute FlexSearch query across fields
        const rawResults = documentIndex.search(query, {
          limit: 10000,
          suggest: true,
        });

        // Collect matched IDs and score by recurrence across index fields
        const scoreMap = new Map<string, number>();

        if (Array.isArray(rawResults)) {
          for (const fieldMatch of rawResults) {
            // fieldMatch format: { field: string, result: (string | number)[] }
            const ids = fieldMatch.result || (Array.isArray(fieldMatch) ? fieldMatch : []);
            for (let rank = 0; rank < ids.length; rank++) {
              const id = String(ids[rank]);
              const weight = fieldMatch.field === 'speaker' || fieldMatch.field === 'entities' ? 3 : 1;
              const currentScore = scoreMap.get(id) || 0;
              // Higher weight for top matches within each field
              scoreMap.set(id, currentScore + weight + Math.max(0, 10 - rank * 0.1));
            }
          }
        }

        // Apply metadata filters and sort by relevance score
        const filteredRankedMatches: { id: string; score: number }[] = [];
        for (const [id, score] of scoreMap.entries()) {
          const meta = chunkMetadata.get(id);
          if (meta) {
            if (sourceIdFilter && meta.source_id !== sourceIdFilter) continue;
            if (classificationFilter && meta.classification !== classificationFilter) continue;
            if (tagFilter && !meta.tags.includes(tagFilter)) continue;
          }
          filteredRankedMatches.push({ id, score });
        }

        filteredRankedMatches.sort((a, b) => b.score - a.score);
        const matchIds = filteredRankedMatches.map((m) => m.id);

        const elapsedMs = Math.round(performance.now() - startTime);
        self.postMessage({
          type: 'SEARCH_RESULTS',
          requestId,
          matchIds,
          elapsedMs,
        } as SearchWorkerResponse);
        break;
      }

      default:
        break;
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown worker error';
    self.postMessage({
      type: 'ERROR',
      requestId,
      error: errorMsg,
    } as SearchWorkerResponse);
  }
};
