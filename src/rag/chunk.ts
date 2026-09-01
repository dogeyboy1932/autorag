/**
 * Recursive text splitter.
 *
 * Splits on the largest natural boundary that fits, falling back to smaller ones:
 * paragraph → line → sentence → word → hard cut. The point is that a chunk should
 * be a coherent unit a human can judge in the review queue — arbitrary character
 * windows make the curation UI unreadable.
 *
 * Sizes are in characters, not tokens. all-MiniLM-L6-v2 truncates at 256 word
 * pieces (~1000-1200 chars of English), so TARGET sits just under that: chunks
 * that overflow lose their tail silently at embed time.
 */

export const TARGET_CHARS = 900;
export const OVERLAP_CHARS = 150;
export const MIN_CHARS = 80;

const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];

export interface RawChunk {
  text: string;
  ordinal: number;
}

/**
 * Common HTML entities. Agents routinely paste text lifted from a rendered page,
 * so these arrive far more often than raw tags do.
 */
const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
};

/**
 * Page furniture that carries no meaning but embeds just fine, polluting
 * retrieval. Matched against a whole trimmed line, never mid-sentence, so a
 * passage that legitimately discusses cookies is untouched.
 */
const BOILERPLATE =
  /^(skip to (main )?content|accept( all)?( cookies)?|cookie (policy|settings|preferences)|sign ?in|log ?in|subscribe|advertisement|share this|related articles?|read more|menu|search|navigation|back to top|©.*|all rights reserved.*)$/i;

/**
 * Normalizes whatever an agent hands us into plain prose.
 *
 * Sources are deliberately varied — encyclopedia prose, availability tables,
 * aggregator score cards, studio press releases — so this has to survive markup
 * fragments, entity soup, bullet lists and navigation chrome without the caller
 * having to clean anything first.
 */
export function normalizeText(input: string): string {
  let text = input.replace(/\r\n?/g, '\n');

  // Script and style bodies are pure noise if a raw fragment slipped through.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Block-level tags become paragraph breaks so structure survives as prose.
  text = text.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/?(td|th)\b[^>]*>/gi, ' · ');
  text = text.replace(/<[^>]+>/g, '');

  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char);
  }
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // Bullet glyphs carry no semantic weight once the line break is preserved.
  text = text.replace(/^[ \t]*[•·▪◦*\u2013\u2014-]\s+/gm, '');

  const lines = text
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]+/g, ' ')
        // Adjacent cell boundaries (</td><td>) each emit a separator; collapse
        // the runs and drop the ones left dangling at either end of a row.
        .replace(/(?:\s*·\s*){2,}/g, ' · ')
        .replace(/^\s*·\s*|\s*·\s*$/g, '')
        .trim(),
    )
    .filter((line) => line.length > 0 && !BOILERPLATE.test(line));

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitRecursive(text: string, sepIndex: number): string[] {
  if (text.length <= TARGET_CHARS) return [text];

  const sep = SEPARATORS[sepIndex];
  if (sep === undefined) {
    // Out of separators: hard-cut on the character grid.
    const out: string[] = [];
    for (let i = 0; i < text.length; i += TARGET_CHARS) {
      out.push(text.slice(i, i + TARGET_CHARS));
    }
    return out;
  }

  const parts = text.split(sep);
  if (parts.length === 1) return splitRecursive(text, sepIndex + 1);

  // Greedily repack the parts into TARGET-sized groups, recursing into any
  // single part that is still oversized on its own.
  const out: string[] = [];
  let buf = '';
  for (const part of parts) {
    const candidate = buf ? buf + sep + part : part;
    if (candidate.length <= TARGET_CHARS) {
      buf = candidate;
      continue;
    }
    if (buf) out.push(buf);
    if (part.length > TARGET_CHARS) {
      out.push(...splitRecursive(part, sepIndex + 1));
      buf = '';
    } else {
      buf = part;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Adds a trailing overlap from the previous chunk so a fact split across a
 * boundary is still retrievable from at least one side.
 */
function withOverlap(pieces: string[]): string[] {
  if (pieces.length <= 1) return pieces;
  return pieces.map((piece, i) => {
    if (i === 0) return piece;
    const prev = pieces[i - 1];
    const tail = prev.slice(Math.max(0, prev.length - OVERLAP_CHARS));
    // Start the overlap at a word boundary so it doesn't open mid-token.
    const cut = tail.indexOf(' ');
    return (cut === -1 ? tail : tail.slice(cut + 1)) + ' ' + piece;
  });
}

export function chunkText(input: string): RawChunk[] {
  const normalized = normalizeText(input);
  if (!normalized) return [];

  const pieces = splitRecursive(normalized, 0)
    .map((p) => p.trim())
    .filter(Boolean);

  // Fold a runt tail into its predecessor rather than indexing a fragment.
  const merged: string[] = [];
  for (const piece of pieces) {
    if (piece.length < MIN_CHARS && merged.length > 0) {
      merged[merged.length - 1] += ' ' + piece;
    } else {
      merged.push(piece);
    }
  }

  return withOverlap(merged).map((text, ordinal) => ({ text, ordinal }));
}
