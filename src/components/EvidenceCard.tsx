import React, { useState, useEffect } from 'react';
import {
  Check,
  Copy,
  FileCheck2,
  MessageSquareQuote,
  AlertTriangle,
  StickyNote,
  Tag,
  Plus,
  X,
  Hash,
} from 'lucide-react';
import { ClassificationType, EvidenceChunk, SourceType } from '../types';
import { addCustomTagToChunk, removeCustomTagFromChunk } from '../db';

interface EvidenceCardProps {
  chunk: EvidenceChunk;
  isHighlighted?: boolean;
  isJumpTarget?: boolean;
  onSelectEntity: (entity: string) => void;
  onSelectSource: (sourceId: string) => void;
  onSelectTag?: (tag: string) => void;
  onTagsChanged?: (chunkId: string, tags: string[]) => void;
}

export const CLASSIFICATION_META: Record<
  ClassificationType,
  {
    label: string;
    textClass: string;
    dotClass: string;
    Icon: React.ComponentType<{ className?: string }>;
  }
> = {
  verified_record: {
    label: 'Verified Record',
    textClass: 'text-emerald-400',
    dotClass: 'text-emerald-400',
    Icon: FileCheck2,
  },
  spoken_statement: {
    label: 'Spoken Statement',
    textClass: 'text-sky-400',
    dotClass: 'text-sky-400',
    Icon: MessageSquareQuote,
  },
  allegation_or_claim: {
    label: 'Allegation / Claim',
    textClass: 'text-amber-400',
    dotClass: 'text-amber-400',
    Icon: AlertTriangle,
  },
  editorial_note: {
    label: 'Editorial Note',
    textClass: 'text-violet-400',
    dotClass: 'text-violet-400',
    Icon: StickyNote,
  },
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  archival_audio: 'Archival Audio',
  court_filing: 'Court Filing',
  witness_interview: 'Witness Interview',
  editorial_note: 'Editorial Note',
};

const PRESET_TAGS = [
  '#timeline',
  '#witness',
  '#key-document',
  '#corroborated',
  '#contradiction',
  '#alibi',
];

const EvidenceCardComponent: React.FC<EvidenceCardProps> = ({
  chunk,
  isHighlighted = false,
  isJumpTarget = false,
  onSelectEntity,
  onSelectSource,
  onSelectTag,
  onTagsChanged,
}) => {
  const [copied, setCopied] = useState(false);
  const [tags, setTags] = useState<string[]>(chunk.custom_tags || []);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [isSavingTag, setIsSavingTag] = useState(false);

  useEffect(() => {
    setTags(chunk.custom_tags || []);
  }, [chunk.custom_tags]);

  const meta =
    CLASSIFICATION_META[chunk.classification] ||
    CLASSIFICATION_META.spoken_statement;
  const StatusIcon = meta.Icon;

  const handleCopyPill = async () => {
    try {
      await navigator.clipboard.writeText(chunk.citation_pill);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = chunk.citation_pill;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const handleAddTag = async (rawTag: string) => {
    const trimmed = rawTag.trim();
    if (!trimmed) return;

    setIsSavingTag(true);
    try {
      const updated = await addCustomTagToChunk(chunk.chunk_id, trimmed);
      setTags(updated);
      setTagInput('');
      setIsAddingTag(false);
      onTagsChanged?.(chunk.chunk_id, updated);
    } catch (err) {
      console.error('Failed adding tag to chunk:', err);
    } finally {
      setIsSavingTag(false);
    }
  };

  const handleRemoveTag = async (tagToRemove: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const updated = await removeCustomTagFromChunk(chunk.chunk_id, tagToRemove);
      setTags(updated);
      onTagsChanged?.(chunk.chunk_id, updated);
    } catch (err) {
      console.error('Failed removing tag from chunk:', err);
    }
  };

  return (
    <article
      id={chunk.chunk_id}
      className={`group rounded-lg border transition-all duration-200 p-5 ${
        isJumpTarget
          ? 'bg-[#1b253b] border-amber-400 ring-2 ring-amber-400 shadow-[0_0_24px_rgba(245,158,11,0.4)] animate-pulse'
          : isHighlighted
          ? 'bg-[#172236] border-amber-500/60 shadow-lg shadow-amber-500/5'
          : 'bg-[#121926] border-slate-800/90 hover:border-slate-700'
      }`}
    >
      {/* Top Row: Unboxed Metadata Line (Zero-Pill Discipline) + Copy Citation Action */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span
            className={`inline-flex items-center gap-1.5 font-medium ${meta.textClass}`}
          >
            <StatusIcon className="w-3.5 h-3.5 shrink-0" />
            <span>{meta.label}</span>
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <button
            type="button"
            onClick={() => onSelectSource(chunk.source_id)}
            className="text-slate-300 hover:text-white hover:underline transition-colors font-medium truncate max-w-[240px]"
            title={`Filter by source: ${chunk.source_title}`}
          >
            {chunk.source_title}
          </button>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className="text-slate-400">
            {SOURCE_TYPE_LABELS[chunk.source_type] || chunk.source_type}
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className="font-mono tabular-nums text-slate-400">
            {chunk.page_or_section || chunk.coordinate}
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className="font-mono tabular-nums text-slate-500">
            {chunk.chunk_id}
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopyPill}
          className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            copied
              ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300'
              : 'bg-slate-900/90 border-slate-700/80 text-slate-300 hover:border-amber-500/60 hover:text-amber-300'
          }`}
          title="Click to copy exact timeline citation bracket"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Copied Pill</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5 text-amber-400/90 shrink-0" />
              <span>Copy Pill</span>
            </>
          )}
        </button>
      </div>

      {/* Interactive Citation Pill Bar — Single Click Copies Formatted Bracket Tag */}
      <div className="mb-3.5">
        <button
          type="button"
          onClick={handleCopyPill}
          className={`w-full text-left font-mono text-xs sm:text-[13px] leading-relaxed px-3.5 py-2.5 rounded-md border transition-colors cursor-pointer flex items-center justify-between gap-3 ${
            copied
              ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
              : 'bg-[#0B0F17] border-slate-800/90 text-amber-300/95 hover:border-amber-500/50 hover:bg-[#0E1420]'
          }`}
          title="Click anywhere on this citation tag to copy to clipboard"
        >
          <span className="break-all select-all">{chunk.citation_pill}</span>
          <span className="text-[11px] font-sans text-slate-500 group-hover:text-slate-300 whitespace-nowrap shrink-0">
            {copied ? 'Copied!' : 'Click to copy'}
          </span>
        </button>
      </div>

      {/* Analytical Summary */}
      <p className="text-sm font-medium text-slate-100 leading-snug mb-2.5">
        {chunk.summary}
      </p>

      {/* Verbatim Chunk Excerpt */}
      <p className="text-[14px] text-slate-300/90 leading-relaxed mb-3.5 font-normal">
        <span className="text-slate-400 font-medium">{chunk.speaker}</span>
        <span className="text-slate-600 mx-1.5">
          ({chunk.coordinate})
        </span>
        {chunk.text}
      </p>

      {/* Tag Management System: Custom IndexedDB Metadata Tags */}
      <div className="pt-2.5 mb-2 border-t border-slate-800/70 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 mr-1">
          <Tag className="w-3 h-3 text-amber-400/80" />
          <span>Tags:</span>
        </span>

        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-colors"
          >
            <button
              type="button"
              onClick={() => onSelectTag?.(tag)}
              className="hover:underline cursor-pointer"
              title={`Filter by tag: ${tag}`}
            >
              {tag}
            </button>
            <button
              type="button"
              onClick={(e) => handleRemoveTag(tag, e)}
              className="text-amber-400/60 hover:text-red-400 ml-0.5 cursor-pointer p-0.5"
              title={`Remove ${tag}`}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}

        {!isAddingTag ? (
          <button
            type="button"
            onClick={() => setIsAddingTag(true)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 transition-colors cursor-pointer"
            title="Add custom tag (e.g. #timeline, #witness, #key-document)"
          >
            <Plus className="w-3 h-3" />
            <span>Tag</span>
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 bg-[#0B0F17] p-1.5 rounded-md border border-amber-500/40 mt-1 sm:mt-0">
            <div className="flex items-center gap-1">
              <Hash className="w-3 h-3 text-amber-400 shrink-0" />
              <input
                type="text"
                autoFocus
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag(tagInput);
                  } else if (e.key === 'Escape') {
                    setIsAddingTag(false);
                    setTagInput('');
                  }
                }}
                placeholder="tag-name (Enter)"
                className="w-28 px-1.5 py-0.5 text-[11px] font-mono bg-[#141D2E] border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
              />
              <button
                type="button"
                disabled={isSavingTag || !tagInput.trim()}
                onClick={() => handleAddTag(tagInput)}
                className="px-2 py-0.5 text-[11px] font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded cursor-pointer"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsAddingTag(false);
                  setTagInput('');
                }}
                className="p-1 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Quick Suggestions */}
            <div className="flex items-center gap-1 border-l border-slate-800 pl-1.5 text-[10px] text-slate-500">
              <span className="hidden sm:inline">Quick:</span>
              {PRESET_TAGS.filter((pt) => !tags.includes(pt))
                .slice(0, 3)
                .map((pt) => (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => handleAddTag(pt)}
                    className="hover:text-amber-300 font-mono text-slate-400 underline cursor-pointer"
                  >
                    {pt}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer: Named Entities as Quiet Unboxed Interactive Text Links */}
      {chunk.named_entities && chunk.named_entities.length > 0 && (
        <div className="pt-2 border-t border-slate-800/70 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
          <span className="text-slate-500">Referenced entities:</span>
          {chunk.named_entities.map((entity, idx) => (
            <React.Fragment key={`${chunk.chunk_id}_ent_${idx}`}>
              {idx > 0 && (
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
              )}
              <button
                type="button"
                onClick={() => onSelectEntity(entity)}
                className="text-slate-300 hover:text-amber-300 hover:underline transition-colors cursor-pointer"
                title={`Filter vault by entity: ${entity}`}
              >
                {entity}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </article>
  );
};

export const EvidenceCard = React.memo(EvidenceCardComponent);
