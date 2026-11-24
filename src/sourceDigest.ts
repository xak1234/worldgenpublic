import 'dotenv/config';

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

// Cap the input we send to the LLM. v4-flash handles ~128K input tokens ≈ ~380K chars; we cap
// well below that to leave room for the system prompt and to keep calls fast/cheap.
const MAX_INPUT_CHARS = 200_000;

const SYSTEM = `You are a story-analysis assistant. Read the provided source material (script, screenplay, novel, transcript, or article) and produce a STRUCTURED CANONICAL DIGEST of the ENTIRE story, beginning to end. Return ONLY structured plain text in the exact format requested — no markdown headers, no commentary outside the structure.`;

function userPrompt(sourceTitle: string, sourceKind: string, text: string): string {
  return `Source title: ${sourceTitle}
Source kind: ${sourceKind}

----- BEGIN SOURCE -----
${text}
----- END SOURCE -----

Produce a structured canonical digest in this exact format (target ~6000-8000 chars total):

CHARACTERS:
- <full name> (<role / actor if known>): <one-paragraph arc — who they are, key relationships, what happens to them, do they live or die, how their story resolves>
- ...

LOCATIONS:
- <location name>: <one-sentence description grounded in the actual scenes from this source>
- ...

PLOT (chronological, ALL major beats in order — opening through climax through ending):
1. <scene title>: <2-3 sentence summary of what happens, who is there, what is revealed>
2. ...
N. <climax title>: <climactic moment>
N+1. <ending title>: <how it actually ends, including any twists or resolution>

THEMES: <2-3 sentence statement of the source's themes>
TONE: <2-3 adjectives describing voice/mood>
ENDING TYPE: <tragic / triumphant / bittersweet / open / cyclical / ambiguous>

CRITICAL: This digest is the canonical reference for downstream story generation. Include the ACTUAL ending. Include the climax. Cover the FULL story arc — not just the opening. Be specific to this source — use real names, real locations, real plot beats from THIS material. Do NOT generalize or invent content not present in the source.`;
}

function storyArcExcerpt(fullText: string, maxChars: number): { text: string; excerpted: boolean } {
  if (fullText.length <= maxChars) return { text: fullText, excerpted: false };
  const markerBudget = 1200;
  const segment = Math.max(1000, Math.floor((maxChars - markerBudget) / 3));
  const middleStart = Math.max(0, Math.floor((fullText.length - segment) / 2));
  const tailStart = Math.max(0, fullText.length - segment);
  const text = [
    `[SOURCE EXCERPT: BEGINNING — chars 1-${segment}]`,
    fullText.slice(0, segment),
    `[SOURCE EXCERPT: MIDDLE — chars ${middleStart + 1}-${middleStart + segment}]`,
    fullText.slice(middleStart, middleStart + segment),
    `[SOURCE EXCERPT: ENDING / OUTCOME — chars ${tailStart + 1}-${fullText.length}]`,
    fullText.slice(tailStart),
  ].join('\n\n');
  return { text: text.slice(0, maxChars), excerpted: true };
}

export interface DigestOptions {
  sourceTitle?: string;
  sourceKind?: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Build a structured whole-story digest from a source text.
 * Uses DeepSeek v4-flash by default (set DEEPSEEK_API_KEY in .env).
 *
 * Returns a plain-text digest with CHARACTERS / LOCATIONS / PLOT / THEMES / TONE / ENDING sections.
 * Caller is responsible for attaching to world.sourceDocuments[].digest.
 *
 * @throws if DEEPSEEK_API_KEY is missing, if the API errors, or if the response is empty.
 */
export async function buildSourceDigest(fullText: string, opts: DigestOptions = {}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('buildSourceDigest requires DEEPSEEK_API_KEY env var');
  if (!fullText || fullText.trim().length < 200) {
    throw new Error(`buildSourceDigest: source text too short (${fullText?.length ?? 0} chars; need >=200)`);
  }
  const { text, excerpted } = storyArcExcerpt(fullText, MAX_INPUT_CHARS);
  const sourceTitle = opts.sourceTitle ?? 'Unknown source';
  const sourceKind = opts.sourceKind ?? 'Book/Film/Script';
  const baseUrl = DEEPSEEK_BASE.replace(/\/+$/, '').replace(/\/v1$/i, ''); // with or without /v1

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: opts.maxOutputTokens ?? 8000,
      temperature: opts.temperature ?? 0.3,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(sourceTitle, sourceKind, text) },
      ],
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`DeepSeek digest API error ${res.status}: ${errBody.slice(0, 600)}`);
  }
  const data: any = await res.json();
  const digest = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!digest) throw new Error('Empty DeepSeek digest response');
  if (excerpted) {
    return digest + `\n\n[NOTE: Source exceeded ${MAX_INPUT_CHARS} chars; digest generation used beginning, middle, and ending/outcome excerpts so the full story arc was represented.]`;
  }
  return digest;
}
