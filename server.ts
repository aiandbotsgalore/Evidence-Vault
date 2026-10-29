import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function generateWithArgonFallback(
  ai: GoogleGenAI,
  contents: string,
  config: Record<string, unknown>
): Promise<{ text: string; modelUsed: string }> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-argon',
      contents,
      config,
    });
    return {
      text: response.text || '',
      modelUsed: 'gemini-4-argon',
    };
  } catch (err) {
    // Graceful fallback to gemini-3.8-flash if the user declined a paid key for gemini-4-argon
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents,
      config,
    });
    return {
      text: response.text || '',
      modelUsed: 'gemini-3.8-flash',
    };
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  /**
   * POST /api/enrich-chunks
   * Accepts up to 30 deterministically parsed chunks and enriches each with:
   * - classification: verified_record | spoken_statement | allegation_or_claim | editorial_note
   * - summary: concise 1-sentence analytical distillation
   * - named_entities: array of referenced names/entities
   * - quote_snippet: exact verbatim key substring from the chunk text
   */
  app.post('/api/enrich-chunks', async (req, res) => {
    try {
      const { sourceTitle, sourceType, chunks } = req.body as {
        sourceTitle: string;
        sourceType: string;
        chunks: {
          chunk_id: string;
          speaker: string;
          coordinate: string;
          text: string;
        }[];
      };

      if (!Array.isArray(chunks) || chunks.length === 0) {
        res.status(400).json({ error: 'No chunks provided for enrichment.' });
        return;
      }

      const batch = chunks.slice(0, 30);
      const ai = getGenAIClient();

      if (!ai) {
        res.status(503).json({
          error: 'GEMINI_API_KEY not configured on server; using local deterministic classifier.',
          fallback: true,
        });
        return;
      }

      const prompt = `You are an investigative documentary evidence analyst.
Analyze the following ${batch.length} deterministically segmented chunks from source "${sourceTitle}" (source type: ${sourceType}).

For EVERY chunk in the input array, return a corresponding object with the exact same "chunk_id" and:
1. "classification": Must be strictly one of:
   - "verified_record": Official court filings, metered audits, dated legal exhibits, sworn stipulations, or verifiable documentary records.
   - "spoken_statement": Direct witness testimony, interview answers, neutral observations, or host questions.
   - "allegation_or_claim": Unproven accusations, contested whistleblower claims, conspiracy allegations, or disputed assertions.
   - "editorial_note": Producer notes, script directions, TODOs, or legal clearance reminders.
2. "summary": A concise, sharp 1-sentence analytical insight distilling the evidentiary significance of the chunk.
3. "named_entities": Array of 1 to 5 specific people, organizations, docket numbers, or locations mentioned.
4. "quote_snippet": An EXACT verbatim substring copied directly from the chunk's "text" (between 25 and 85 characters) that captures the most quotable clause. Do NOT paraphrase or alter words.

Input Chunks JSON:
${JSON.stringify(batch, null, 2)}`;

      const { text, modelUsed } = await generateWithArgonFallback(ai, prompt, {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              chunk_id: {
                type: Type.STRING,
                description: 'The exact chunk_id from the input.',
              },
              classification: {
                type: Type.STRING,
                description:
                  'One of: verified_record, spoken_statement, allegation_or_claim, editorial_note',
              },
              summary: {
                type: Type.STRING,
                description: 'Concise 1-sentence analytical summary.',
              },
              named_entities: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Key named entities referenced in the chunk.',
              },
              quote_snippet: {
                type: Type.STRING,
                description:
                  'Exact verbatim substring from the chunk text (25-85 chars).',
              },
            },
            required: [
              'chunk_id',
              'classification',
              'summary',
              'named_entities',
              'quote_snippet',
            ],
          },
        },
      });

      const parsed = JSON.parse(text.trim());
      res.json({
        items: parsed,
        modelUsed,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Argon enrichment failed';
      res.status(500).json({ error: message, fallback: true });
    }
  });

  /**
   * POST /api/ask-vault
   * Thematic evidence retrieval across the corpus using gemini-4-argon.
   * Synthesizes an investigative memo citing exact `[Speaker Coordinate "Quote"]` tags
   * and returns the matching `chunk_id`s so the UI can filter the card feed.
   */
  app.post('/api/ask-vault', async (req, res) => {
    try {
      const { query, chunks } = req.body as {
        query: string;
        chunks: {
          chunk_id: string;
          source_title: string;
          speaker: string;
          coordinate: string;
          classification: string;
          citation_pill: string;
          summary: string;
          text: string;
          named_entities: string[];
        }[];
      };

      if (!query || !Array.isArray(chunks)) {
        res.status(400).json({ error: 'Query and chunks array are required.' });
        return;
      }

      const ai = getGenAIClient();
      if (!ai) {
        res.status(503).json({
          error: 'GEMINI_API_KEY not configured; falling back to local thematic synthesis.',
          fallback: true,
        });
        return;
      }

      const compactCatalog = chunks.slice(0, 120).map((c) => ({
        chunk_id: c.chunk_id,
        source: c.source_title,
        classification: c.classification,
        citation_pill: c.citation_pill,
        summary: c.summary,
        text: c.text,
      }));

      const prompt = `You are the investigative research engine for "Evidence Vault".
Answer the user's thematic query strictly using the provided evidence chunks.
Contrast "verified_record" items against "allegation_or_claim" items where relevant.
Whenever you cite a piece of evidence in your "synthesis" paragraph, embed its EXACT "citation_pill" string verbatim in brackets (for example: [Eric Hecker 2:02:15 "who do you think the scumbags are?"] or [Doc: Filing p. 4 "The petition was entered..."]).

User Query: "${query}"

Evidence Corpus JSON:
${JSON.stringify(compactCatalog, null, 2)}`;

      const { text, modelUsed } = await generateWithArgonFallback(ai, prompt, {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            synthesis: {
              type: Type.STRING,
              description:
                '2-4 sentence investigative synthesis answering the query with inline exact citation_pill tags.',
            },
            matched_chunk_ids: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description:
                'Array of chunk_id strings for the evidence chunks most relevant to the query.',
            },
            key_entities: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Key entities involved in this thematic thread.',
            },
          },
          required: ['synthesis', 'matched_chunk_ids', 'key_entities'],
        },
      });

      const parsed = JSON.parse(text.trim());
      res.json({
        query,
        synthesis: parsed.synthesis,
        matched_chunk_ids: parsed.matched_chunk_ids || [],
        key_entities: parsed.key_entities || [],
        used_model: modelUsed,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Ask Vault synthesis failed';
      res.status(500).json({ error: message, fallback: true });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Evidence Vault server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
