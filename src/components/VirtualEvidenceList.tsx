import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronUp,
  ChevronDown,
  Loader2,
  Database,
  Crosshair,
  SlidersHorizontal,
  Layers,
  Sparkles,
  Search,
} from 'lucide-react';
import { db, getOrderedChunkIds } from '../db';
import type { ClassificationType, EvidenceChunk } from '../types';
import { EvidenceCard } from './EvidenceCard';

export interface MatchCluster {
  id: string;
  startIndex: number;
  endIndex: number;
  centerIndex: number;
  count: number;
  matchChunkIds: string[];
  topPercent: number; // 0 to 100
  previewSpeaker?: string;
  previewCoordinate?: string;
  previewSnippet?: string;
}

interface VirtualEvidenceListProps {
  totalCount: number;
  sourceId: string;
  classification: ClassificationType | 'all';
  tag: string | null;
  searchQuery?: string;
  matchedChunkIds?: string[] | null;
  onSelectEntity: (entity: string) => void;
  onSelectSource: (sourceId: string) => void;
  onSelectTag: (tag: string) => void;
  onTagsChanged: () => void;
  highlightedChunkIds?: string[];
}

const WINDOW_SIZE = 150;
const PREFETCH_THRESHOLD = 25;

export const VirtualEvidenceList: React.FC<VirtualEvidenceListProps> = ({
  totalCount: externalTotalCount,
  sourceId,
  classification,
  tag,
  searchQuery = '',
  matchedChunkIds = null,
  onSelectEntity,
  onSelectSource,
  onSelectTag,
  onTagsChanged,
  highlightedChunkIds = [],
}) => {
  const parentRef = useRef<HTMLDivElement>(null);

  // Search view mode: 'timeline' (In-Context full sequence with match indicators) vs 'filtered' (Matches only)
  const [searchViewMode, setSearchViewMode] = useState<'timeline' | 'filtered'>('timeline');

  // Full ordered chunk IDs for the active scope (used in timeline mode to locate match positions)
  const [scopeOrderedChunkIds, setScopeOrderedChunkIds] = useState<string[]>([]);
  const [effectiveTotalCount, setEffectiveTotalCount] = useState<number>(externalTotalCount);

  // Sliding memory window: keeps only ~150 chunks in memory at any time
  const [windowRange, setWindowRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: Math.min(externalTotalCount, WINDOW_SIZE),
  });
  const [chunkMap, setChunkMap] = useState<Map<number, EvidenceChunk>>(new Map());
  const [isLoadingWindow, setIsLoadingWindow] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);

  // Jump targeting & active cluster navigation state
  const [jumpHighlightedChunkId, setJumpHighlightedChunkId] = useState<string | null>(null);
  const [activeClusterIndex, setActiveClusterIndex] = useState<number>(0);
  const [hoveredCluster, setHoveredCluster] = useState<MatchCluster | null>(null);

  // Viewport scroll metrics for the interactive scrollbar track lens
  const [scrollMetrics, setScrollMetrics] = useState({
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
  });

  // Load scope chunk IDs in order when filters or source change
  useEffect(() => {
    let isCancelled = false;
    const loadScopeIds = async () => {
      try {
        const ids = await getOrderedChunkIds({ sourceId, classification, tag });
        if (!isCancelled) {
          setScopeOrderedChunkIds(ids);
        }
      } catch (err) {
        console.error('Failed loading scope chunk IDs:', err);
      }
    };
    loadScopeIds();
    return () => {
      isCancelled = true;
    };
  }, [sourceId, classification, tag]);

  const hasSearchMatches = matchedChunkIds !== null && matchedChunkIds.length > 0;

  // Determine active count based on search view mode
  useEffect(() => {
    if (hasSearchMatches) {
      if (searchViewMode === 'filtered') {
        setEffectiveTotalCount(matchedChunkIds.length);
      } else {
        setEffectiveTotalCount(
          scopeOrderedChunkIds.length > 0 ? scopeOrderedChunkIds.length : externalTotalCount
        );
      }
    } else {
      setEffectiveTotalCount(externalTotalCount);
    }
  }, [hasSearchMatches, searchViewMode, matchedChunkIds, scopeOrderedChunkIds, externalTotalCount]);

  // TanStack Virtualizer with dynamic measurement
  const virtualizer = useVirtualizer({
    count: effectiveTotalCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 210, // Initial height estimate for evidence card
    overscan: 8,
  });

  // Calculate match clusters along the scrollbar track
  const clusters = useMemo<MatchCluster[]>(() => {
    if (!hasSearchMatches || !matchedChunkIds || matchedChunkIds.length === 0) {
      return [];
    }

    const matchSet = new Set(matchedChunkIds);
    const matchItems: { index: number; chunkId: string }[] = [];

    if (searchViewMode === 'timeline' && scopeOrderedChunkIds.length > 0) {
      // Timeline Mode: find indices where matches occur throughout the full corpus
      for (let i = 0; i < scopeOrderedChunkIds.length; i++) {
        const id = scopeOrderedChunkIds[i];
        if (matchSet.has(id)) {
          matchItems.push({ index: i, chunkId: id });
        }
      }
    } else {
      // Filtered Mode: matches correspond to indices 0..matchedChunkIds.length - 1
      for (let i = 0; i < matchedChunkIds.length; i++) {
        matchItems.push({ index: i, chunkId: matchedChunkIds[i] });
      }
    }

    if (matchItems.length === 0) return [];

    const total = Math.max(1, effectiveTotalCount);
    // Cluster threshold: items within 2.5% of total rows (or within 4 rows) group together
    const clusterThreshold = Math.max(3, Math.round(total * 0.025));

    const resultClusters: MatchCluster[] = [];
    let currentBatch: { index: number; chunkId: string }[] = [matchItems[0]];

    for (let i = 1; i < matchItems.length; i++) {
      const prev = currentBatch[currentBatch.length - 1];
      const curr = matchItems[i];

      if (curr.index - prev.index <= clusterThreshold) {
        currentBatch.push(curr);
      } else {
        // Finalize cluster
        const startIdx = currentBatch[0].index;
        const endIdx = currentBatch[currentBatch.length - 1].index;
        const centerIdx = Math.round((startIdx + endIdx) / 2);
        const topPct = Math.min(97.5, Math.max(1.5, (centerIdx / Math.max(1, total - 1)) * 100));

        resultClusters.push({
          id: `cluster_${resultClusters.length}`,
          startIndex: startIdx,
          endIndex: endIdx,
          centerIndex: centerIdx,
          count: currentBatch.length,
          matchChunkIds: currentBatch.map((b) => b.chunkId),
          topPercent: topPct,
        });
        currentBatch = [curr];
      }
    }

    if (currentBatch.length > 0) {
      const startIdx = currentBatch[0].index;
      const endIdx = currentBatch[currentBatch.length - 1].index;
      const centerIdx = Math.round((startIdx + endIdx) / 2);
      const topPct = Math.min(97.5, Math.max(1.5, (centerIdx / Math.max(1, total - 1)) * 100));

      resultClusters.push({
        id: `cluster_${resultClusters.length}`,
        startIndex: startIdx,
        endIndex: endIdx,
        centerIndex: centerIdx,
        count: currentBatch.length,
        matchChunkIds: currentBatch.map((b) => b.chunkId),
        topPercent: topPct,
      });
    }

    return resultClusters;
  }, [hasSearchMatches, matchedChunkIds, searchViewMode, scopeOrderedChunkIds, effectiveTotalCount]);

  // Unique query key to trigger fresh window reload when filters change
  const queryFingerprint = useMemo(() => {
    return `${sourceId}|${classification}|${tag || ''}|${searchQuery}|${
      matchedChunkIds ? matchedChunkIds.slice(0, 10).join(',') : ''
    }|${effectiveTotalCount}|${searchViewMode}`;
  }, [sourceId, classification, tag, searchQuery, matchedChunkIds, effectiveTotalCount, searchViewMode]);

  /**
   * Fetches an IndexedDB slice for the active memory window.
   */
  const fetchWindow = useCallback(
    async (start: number, count: number) => {
      if (effectiveTotalCount === 0 || count <= 0) {
        setChunkMap(new Map());
        return;
      }

      setIsLoadingWindow(true);
      try {
        let loadedItems: EvidenceChunk[] = [];

        if (hasSearchMatches && searchViewMode === 'filtered' && matchedChunkIds) {
          // If in Filtered Mode, fetch items by primary key bulkGet from matchedChunkIds
          const sliceIds = matchedChunkIds.slice(start, start + count);
          const retrieved = await db.chunks.bulkGet(sliceIds);
          loadedItems = retrieved.filter((c): c is EvidenceChunk => c !== undefined);
        } else if (hasSearchMatches && searchViewMode === 'timeline' && scopeOrderedChunkIds.length > 0) {
          // In Timeline Mode, fetch using scopeOrderedChunkIds slice
          const sliceIds = scopeOrderedChunkIds.slice(start, start + count);
          const retrieved = await db.chunks.bulkGet(sliceIds);
          loadedItems = retrieved.filter((c): c is EvidenceChunk => c !== undefined);
        } else {
          // Query Dexie directly leveraging single/compound indexes
          let collection = db.chunks.toCollection();

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
          }

          if (tag && (sourceId !== 'all' || classification !== 'all')) {
            collection = collection.filter(
              (c) => Array.isArray(c.custom_tags) && c.custom_tags.includes(tag)
            );
          }

          if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            collection = collection.filter((c) => {
              return (
                c.speaker?.toLowerCase().includes(q) ||
                c.coordinate?.toLowerCase().includes(q) ||
                c.citation_pill?.toLowerCase().includes(q) ||
                c.summary?.toLowerCase().includes(q) ||
                c.text?.toLowerCase().includes(q) ||
                c.source_title?.toLowerCase().includes(q) ||
                (Array.isArray(c.named_entities) &&
                  c.named_entities.some((e) => e.toLowerCase().includes(q))) ||
                (Array.isArray(c.custom_tags) &&
                  c.custom_tags.some((t) => t.toLowerCase().includes(q)))
              );
            });
          }

          loadedItems = await collection.offset(start).limit(count).toArray();
        }

        // Populate new sliding memory window Map
        const newMap = new Map<number, EvidenceChunk>();
        for (let i = 0; i < loadedItems.length; i++) {
          newMap.set(start + i, loadedItems[i]);
        }

        setChunkMap(newMap);
        setWindowRange({ start, end: start + loadedItems.length });
      } catch (err) {
        console.error('Error fetching sliding window from IndexedDB:', err);
      } finally {
        setIsLoadingWindow(false);
      }
    },
    [
      effectiveTotalCount,
      hasSearchMatches,
      searchViewMode,
      matchedChunkIds,
      scopeOrderedChunkIds,
      sourceId,
      classification,
      tag,
      searchQuery,
    ]
  );

  // Reset window to 0 when filters or search change
  useEffect(() => {
    if (parentRef.current) {
      parentRef.current.scrollTop = 0;
    }
    const initialCount = Math.min(effectiveTotalCount, WINDOW_SIZE);
    fetchWindow(0, initialCount);
    setActiveClusterIndex(0);
  }, [queryFingerprint, fetchWindow, effectiveTotalCount]);

  // Monitor virtualizer scroll position to slide the memory window
  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (virtualItems.length === 0 || effectiveTotalCount === 0) return;

    const firstVisible = virtualItems[0].index;
    const lastVisible = virtualItems[virtualItems.length - 1].index;

    // Show floating scroll to top button
    setShowScrollTop(firstVisible > 15);

    // Check if user is scrolling near the edges of the active sliding window
    const nearTopEdge =
      firstVisible < windowRange.start + PREFETCH_THRESHOLD && windowRange.start > 0;
    const nearBottomEdge =
      lastVisible > windowRange.end - PREFETCH_THRESHOLD &&
      windowRange.end < effectiveTotalCount;

    if (nearTopEdge || nearBottomEdge) {
      // Re-center window around currently visible rows
      const targetStart = Math.max(0, Math.floor(firstVisible - WINDOW_SIZE / 3));
      const targetEnd = Math.min(effectiveTotalCount, targetStart + WINDOW_SIZE);

      if (targetStart !== windowRange.start) {
        fetchWindow(targetStart, targetEnd - targetStart);
      }
    }
  }, [virtualItems, windowRange, effectiveTotalCount, fetchWindow]);

  const handleContainerScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  };

  /**
   * Jumps the virtual list directly to a result cluster index and triggers an active pulse ring.
   */
  const handleJumpToCluster = useCallback(
    (cluster: MatchCluster, clusterIndex?: number) => {
      if (clusterIndex !== undefined) {
        setActiveClusterIndex(clusterIndex);
      } else {
        const foundIdx = clusters.findIndex((c) => c.id === cluster.id);
        if (foundIdx !== -1) setActiveClusterIndex(foundIdx);
      }

      // Pre-fetch memory window centered around target row immediately
      const windowStart = Math.max(0, cluster.startIndex - 15);
      fetchWindow(windowStart, WINDOW_SIZE);

      // Scroll virtualizer smoothly to the target row
      virtualizer.scrollToIndex(cluster.startIndex, {
        align: 'center',
        behavior: 'smooth',
      });

      // Highlight target card with pulsing amber ring
      const targetId = cluster.matchChunkIds[0];
      setJumpHighlightedChunkId(targetId);
      setTimeout(() => {
        setJumpHighlightedChunkId((prev) => (prev === targetId ? null : prev));
      }, 3000);
    },
    [virtualizer, fetchWindow, clusters]
  );

  const handleNextCluster = () => {
    if (clusters.length === 0) return;
    const nextIdx = (activeClusterIndex + 1) % clusters.length;
    handleJumpToCluster(clusters[nextIdx], nextIdx);
  };

  const handlePrevCluster = () => {
    if (clusters.length === 0) return;
    const prevIdx = (activeClusterIndex - 1 + clusters.length) % clusters.length;
    handleJumpToCluster(clusters[prevIdx], prevIdx);
  };

  // Keyboard shortcut listener for F3 / Shift+F3 navigation between clusters
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (clusters.length === 0) return;
      if (e.key === 'F3') {
        e.preventDefault();
        if (e.shiftKey) {
          handlePrevCluster();
        } else {
          handleNextCluster();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clusters, activeClusterIndex]);

  const scrollToTop = () => {
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const highlightSet = useMemo(() => {
    const set = new Set(highlightedChunkIds);
    if (hasSearchMatches && matchedChunkIds) {
      for (const id of matchedChunkIds) {
        set.add(id);
      }
    }
    return set;
  }, [highlightedChunkIds, hasSearchMatches, matchedChunkIds]);

  // Compute scrollbar track viewport lens metrics
  const viewportTopPercent =
    scrollMetrics.scrollHeight > 0
      ? (scrollMetrics.scrollTop / scrollMetrics.scrollHeight) * 100
      : 0;
  const viewportHeightPercent =
    scrollMetrics.scrollHeight > 0
      ? Math.min(100, (scrollMetrics.clientHeight / scrollMetrics.scrollHeight) * 100)
      : 100;

  return (
    <div className="relative">
      {/* Sliding Window Status & Search Match Cluster Toolbar */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono px-1">
        <div className="flex flex-wrap items-center gap-2">
          <Database className="w-3.5 h-3.5 text-amber-400" />
          <span>
            Memory Window: <strong className="text-slate-200">{chunkMap.size}</strong> buffered
            cards ({effectiveTotalCount} total in view)
          </span>

          {isLoadingWindow && (
            <span className="inline-flex items-center gap-1 text-amber-400 ml-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Paging cursor...</span>
            </span>
          )}

          {/* Result Clusters Navigator Badge */}
          {clusters.length > 0 && (
            <div className="inline-flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300">
              <Crosshair className="w-3 h-3 text-amber-400 shrink-0" />
              <span className="font-semibold text-white">
                Cluster {activeClusterIndex + 1} of {clusters.length}
              </span>
              <span className="text-amber-400/80">({matchedChunkIds?.length} matches)</span>

              <div className="flex items-center gap-0.5 ml-1 border-l border-amber-500/30 pl-1">
                <button
                  type="button"
                  onClick={handlePrevCluster}
                  className="p-0.5 hover:text-white hover:bg-amber-500/30 rounded cursor-pointer transition-colors"
                  title="Jump to previous match cluster (Shift+Enter)"
                  aria-label="Previous cluster"
                >
                  <ChevronUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={handleNextCluster}
                  className="p-0.5 hover:text-white hover:bg-amber-500/30 rounded cursor-pointer transition-colors"
                  title="Jump to next match cluster (Enter)"
                  aria-label="Next cluster"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* View Mode Toggle when Search is Active */}
        {hasSearchMatches && (
          <div className="flex items-center gap-1 bg-[#121926] p-0.5 rounded border border-slate-800 text-[10px]">
            <button
              type="button"
              onClick={() => setSearchViewMode('timeline')}
              className={`px-2 py-1 rounded transition-colors cursor-pointer ${
                searchViewMode === 'timeline'
                  ? 'bg-amber-500 text-slate-950 font-semibold shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Show full chronological context with match pips on the scrollbar"
            >
              Context Timeline
            </button>
            <button
              type="button"
              onClick={() => setSearchViewMode('filtered')}
              className={`px-2 py-1 rounded transition-colors cursor-pointer ${
                searchViewMode === 'filtered'
                  ? 'bg-amber-500 text-slate-950 font-semibold shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Show only matching records"
            >
              Matches Only
            </button>
          </div>
        )}
      </div>

      {/* Main Virtualized Container with Integrated Scrollbar Track Overlay */}
      <div className="relative rounded-lg border border-slate-800/80 bg-[#0B0F17]/40 shadow-inner">
        {/* Virtualized Scroll Area */}
        <div
          ref={parentRef}
          onScroll={handleContainerScroll}
          className={`h-[76vh] min-h-[500px] overflow-y-auto pr-7 relative scrollbar-thin scrollbar-thumb-slate-700/80 scrollbar-track-transparent`}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualRow) => {
              const chunk = chunkMap.get(virtualRow.index);
              const isHighlighted = chunk ? highlightSet.has(chunk.chunk_id) : false;
              const isJumpTarget = chunk ? chunk.chunk_id === jumpHighlightedChunkId : false;

              return (
                <div
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="p-1 pb-3.5"
                >
                  {chunk ? (
                    <EvidenceCard
                      chunk={chunk}
                      isHighlighted={isHighlighted}
                      isJumpTarget={isJumpTarget}
                      onSelectEntity={onSelectEntity}
                      onSelectSource={onSelectSource}
                      onSelectTag={onSelectTag}
                      onTagsChanged={onTagsChanged}
                    />
                  ) : (
                    // Dynamic measurement placeholder skeleton while Dexie cursor window loads
                    <div className="rounded-lg border border-slate-800/80 bg-[#121926]/40 p-5 animate-pulse min-h-[170px] flex flex-col justify-between">
                      <div className="flex items-center justify-between">
                        <div className="h-4 w-48 bg-slate-800 rounded" />
                        <div className="h-4 w-28 bg-slate-800 rounded" />
                      </div>
                      <div className="space-y-2 my-3">
                        <div className="h-3 w-full bg-slate-800/80 rounded" />
                        <div className="h-3 w-5/6 bg-slate-800/60 rounded" />
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="h-3 w-32 bg-slate-800/50 rounded" />
                        <div className="h-5 w-24 bg-slate-800/70 rounded" />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* =========================================================================
            SCROLLBAR TRACK MINI-INDICATORS RAIL (Match Clusters Minimap)
           ========================================================================= */}
        {clusters.length > 0 && (
          <div
            className="absolute right-0 top-0 bottom-0 w-6 z-20 pointer-events-auto bg-[#0E131F]/90 backdrop-blur-xs border-l border-slate-800/90 rounded-r-lg flex flex-col select-none"
            aria-label="Search match indicators minimap"
          >
            {/* Viewport Current Position Indicator Lens */}
            <div
              className="absolute left-0 right-0 bg-slate-700/30 border-y border-amber-500/40 pointer-events-none transition-all duration-75"
              style={{
                top: `${viewportTopPercent}%`,
                height: `${Math.max(4, viewportHeightPercent)}%`,
              }}
            />

            {/* Match Indicators / Clusters Along Track */}
            {clusters.map((cluster, idx) => {
              const isClusterActive = activeClusterIndex === idx;
              const isMultiMatch = cluster.count > 1;

              return (
                <button
                  key={cluster.id}
                  type="button"
                  onClick={() => handleJumpToCluster(cluster, idx)}
                  onMouseEnter={() => setHoveredCluster(cluster)}
                  onMouseLeave={() => setHoveredCluster(null)}
                  style={{ top: `${cluster.topPercent}%` }}
                  className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 group cursor-pointer transition-all duration-150 focus:outline-none ${
                    isClusterActive ? 'scale-125 z-30' : 'hover:scale-120 z-20'
                  }`}
                  aria-label={`Jump to match cluster ${idx + 1}: ${cluster.count} matches around row ${cluster.startIndex + 1}`}
                >
                  {isMultiMatch ? (
                    // Multi-Match Cluster Pill
                    <div
                      className={`h-4 min-w-[16px] px-1 rounded-full text-[8px] font-mono font-black flex items-center justify-center transition-all shadow-md ${
                        isClusterActive
                          ? 'bg-amber-400 text-slate-950 ring-2 ring-white shadow-[0_0_12px_rgba(251,191,36,1)]'
                          : 'bg-amber-500 text-slate-950 hover:bg-amber-300 ring-1 ring-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.9)]'
                      }`}
                    >
                      {cluster.count > 9 ? '9+' : cluster.count}
                    </div>
                  ) : (
                    // Single Match Pip
                    <div
                      className={`h-1.5 w-3 rounded-full transition-all ${
                        isClusterActive
                          ? 'h-2 w-4 bg-white ring-2 ring-amber-400 shadow-[0_0_10px_rgba(255,255,255,1)]'
                          : 'bg-amber-400 hover:bg-amber-300 hover:w-3.5 shadow-[0_0_6px_rgba(245,158,11,0.9)]'
                      }`}
                    />
                  )}
                </button>
              );
            })}

            {/* Hover Tooltip Preview Popover (Docked to left of scrollbar rail) */}
            {hoveredCluster && (
              <div
                style={{
                  top: `${Math.min(85, Math.max(8, hoveredCluster.topPercent))}%`,
                }}
                className="absolute right-7 -translate-y-1/2 z-40 w-64 p-2.5 rounded-lg border border-amber-500/50 bg-[#0E131F]/95 backdrop-blur-md shadow-2xl text-left pointer-events-none animate-in fade-in zoom-in-95 duration-100"
              >
                <div className="flex items-center justify-between gap-1 mb-1 text-[11px]">
                  <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                    <Crosshair className="w-3.5 h-3.5 text-amber-400" />
                    <span>
                      {hoveredCluster.count > 1
                        ? `Cluster: ${hoveredCluster.count} Matches`
                        : 'Single Match'}
                    </span>
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    Row #{hoveredCluster.startIndex + 1}
                    {hoveredCluster.count > 1 ? `–#${hoveredCluster.endIndex + 1}` : ''}
                  </span>
                </div>

                <p className="text-[10px] text-slate-300 leading-snug line-clamp-2">
                  {hoveredCluster.count > 1
                    ? `Click to jump directly to this result cluster in the virtual timeline.`
                    : `Click to jump directly to this testimony coordinate.`}
                </p>

                <div className="mt-1.5 pt-1 border-t border-slate-800 flex items-center justify-between text-[9px] text-slate-400 font-mono">
                  <span>Timeline Position: {Math.round(hoveredCluster.topPercent)}%</span>
                  <span className="text-amber-400">Click to Jump</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Scroll to Top Action */}
      {showScrollTop && (
        <button
          type="button"
          onClick={scrollToTop}
          className="fixed bottom-6 right-8 z-40 p-2.5 rounded-full bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-lg cursor-pointer transition-transform hover:scale-105"
          title="Scroll to top of evidence corpus"
          aria-label="Scroll to top"
        >
          <ChevronUp className="w-5 h-5 stroke-[2.5]" />
        </button>
      )}
    </div>
  );
};
