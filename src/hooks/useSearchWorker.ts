import { useEffect, useRef, useState, useCallback } from 'react';
import type { EvidenceChunk, ClassificationType } from '../types';
import type { SearchWorkerMessage, SearchWorkerResponse } from '../workers/search.worker';

export interface SearchFilters {
  sourceId?: string;
  classification?: ClassificationType | 'all';
  tag?: string | null;
}

export function useSearchWorker() {
  const workerRef = useRef<Worker | null>(null);
  const [isWorkerReady, setIsWorkerReady] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchDurationMs, setSearchDurationMs] = useState<number | null>(null);
  const [totalIndexed, setTotalIndexed] = useState<number>(0);
  const pendingRequestsRef = useRef<Map<string, (matchIds: string[]) => void>>(
    new Map()
  );

  useEffect(() => {
    // Vite Web Worker instantiation with standard ES module
    const worker = new Worker(
      new URL('../workers/search.worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<SearchWorkerResponse>) => {
      const data = e.data;
      if (data.type === 'READY' || data.type === 'INDEXED') {
        setIsWorkerReady(true);
        if (data.totalIndexed !== undefined) {
          setTotalIndexed(data.totalIndexed);
        }
      } else if (data.type === 'SEARCH_RESULTS') {
        setIsSearching(false);
        if (data.elapsedMs !== undefined) {
          setSearchDurationMs(data.elapsedMs);
        }
        if (data.requestId && pendingRequestsRef.current.has(data.requestId)) {
          const resolver = pendingRequestsRef.current.get(data.requestId);
          pendingRequestsRef.current.delete(data.requestId);
          resolver?.(data.matchIds || []);
        }
      } else if (data.type === 'ERROR') {
        setIsSearching(false);
        console.error('Search worker error:', data.error);
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  /**
   * Syncs the entire current set of chunks to the Web Worker FlexSearch index.
   */
  const syncCorpusToWorker = useCallback((chunks: EvidenceChunk[]) => {
    if (!workerRef.current) return;
    const msg: SearchWorkerMessage = {
      type: 'INIT',
      payload: { chunks },
      requestId: `init_${Date.now()}`,
    };
    workerRef.current.postMessage(msg);
  }, []);

  /**
   * Adds newly ingested chunks incrementally to the worker index without a full re-index.
   */
  const addChunksToWorker = useCallback((chunks: EvidenceChunk[]) => {
    if (!workerRef.current || chunks.length === 0) return;
    const msg: SearchWorkerMessage = {
      type: 'ADD',
      payload: { chunks },
      requestId: `add_${Date.now()}`,
    };
    workerRef.current.postMessage(msg);
  }, []);

  /**
   * Clears the worker index.
   */
  const clearWorkerIndex = useCallback(() => {
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: 'CLEAR' });
    setTotalIndexed(0);
  }, []);

  /**
   * Performs offloaded full-text query in the worker thread.
   */
  const executeWorkerSearch = useCallback(
    (query: string, filters: SearchFilters = {}): Promise<string[]> => {
      return new Promise((resolve) => {
        if (!workerRef.current) {
          resolve([]);
          return;
        }

        const requestId = `search_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        pendingRequestsRef.current.set(requestId, resolve);
        setIsSearching(true);

        const msg: SearchWorkerMessage = {
          type: 'SEARCH',
          requestId,
          payload: {
            query,
            filters,
          },
        };
        workerRef.current.postMessage(msg);
      });
    },
    []
  );

  return {
    isWorkerReady,
    isSearching,
    searchDurationMs,
    totalIndexed,
    syncCorpusToWorker,
    addChunksToWorker,
    clearWorkerIndex,
    executeWorkerSearch,
  };
}
