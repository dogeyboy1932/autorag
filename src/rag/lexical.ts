/**
 * Lexical retrieval (BM25) with light typo tolerance.
 *
 * Dense embeddings are strong on paraphrase and weak on exactly the things
 * ordinary people type: a bare number, a proper noun, a rating code. Measured on
 * the seed corpus, "166" put the correct source 4th and every one-word query
 * scored under 0.25 despite being *right*.
 *
 * BM25 covers precisely that gap, so the two are fused in `search.ts` rather than
 * either being used alone.
 */

/**
 * A lexical document. Deliberately not a `Chunk`: the indexed text is the chunk
 * body *prefixed with its source title*, because titles carry topical vocabulary
 * the body often omits. A cast list names actors and no-one ever writes the word
 * "cast" in it — but the page is called "full cast", and that is what someone
 * searches for.
 */
export interface LexDoc {
  id: string;
  text: string;
}

const K1 = 1.2;
const B = 0.75;

/** Words carrying no discriminating signal in a short query. */
const STOP = new Set([
  'a','an','the','is','are','was','were','be','been','of','to','in','on','for','and','or',
  'it','its','this','that','with','as','at','by','from','how','what','who','when','where',
  'why','which','do','does','did','can','i','me','my','you','your','whats',
]);
// Note: "long" and "much" are deliberately NOT stopwords. In "how long is it" and
// "how much does it cost" they are the only words carrying the question, and
// dropping them left those queries with zero content terms — which read as
// zero term coverage, which reported `low` confidence on a correct retrieval.

export function tokenize(text: string): string[] {
  const out: string[] = [];
  // Keep hyphenated forms whole *and* split them, so "PG-13" matches a query of
  // "PG-13", "pg" or "13".
  for (const raw of text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []) {
    out.push(raw);
    if (raw.includes('-')) out.push(...raw.split('-'));
  }
  return out;
}

export function contentTerms(query: string): string[] {
  return [...new Set(tokenize(query))].filter((t) => !STOP.has(t) && t.length > 1);
}

interface Index {
  /** chunkId -> term -> frequency */
  tf: Map<string, Map<string, number>>;
  /** chunkId -> token count */
  len: Map<string, number>;
  /** term -> number of chunks containing it */
  df: Map<string, number>;
  vocab: Set<string>;
  avgLen: number;
  size: number;
}

let cache: Index | null = null;
let cacheKey = '';

/** Rebuilt only when the set of chunk ids changes; tokenizing is not free. */
function buildIndex(docs: LexDoc[]): Index {
  const key = docs.length + ':' + docs.map((d) => d.id).join(',');
  if (cache && cacheKey === key) return cache;

  const tf = new Map<string, Map<string, number>>();
  const len = new Map<string, number>();
  const df = new Map<string, number>();
  const vocab = new Set<string>();
  let total = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    tf.set(doc.id, counts);
    len.set(doc.id, tokens.length);
    total += tokens.length;
    for (const t of counts.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
      vocab.add(t);
    }
  }

  cache = { tf, len, df, vocab, avgLen: docs.length ? total / docs.length : 1, size: docs.length };
  cacheKey = key;
  return cache;
}

export function invalidateLexicalIndex(): void {
  cache = null;
  cacheKey = '';
}

/** Bounded edit distance — returns false as soon as it exceeds `max`. */
function withinEditDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * Maps an unmatched query term onto the closest vocabulary term.
 *
 * Only for terms of 5+ characters, where a single transposition is far more
 * likely to be a typo than a different word — "villenueve" should still find
 * Villeneuve. Short tokens are left alone: at length 3 an edit distance of 1
 * reaches genuinely unrelated words.
 */
function resolveTypo(term: string, vocab: Set<string>): string | null {
  if (term.length < 5 || vocab.has(term)) return null;
  const max = term.length >= 8 ? 2 : 1;
  let best: string | null = null;
  let bestLen = Infinity;
  for (const candidate of vocab) {
    if (Math.abs(candidate.length - term.length) > max) continue;
    if (withinEditDistance(term, candidate, max)) {
      // Prefer the shortest match, which is the least speculative.
      if (candidate.length < bestLen) {
        best = candidate;
        bestLen = candidate.length;
      }
    }
  }
  return best;
}

export interface LexicalResult {
  /** chunkId -> raw BM25 score */
  scores: Map<string, number>;
  /** Query terms after stopword removal and typo correction. */
  terms: string[];
  /** Terms that matched nothing at all in the corpus. */
  unmatched: string[];
}

export function bm25(query: string, docs: LexDoc[]): LexicalResult {
  const index = buildIndex(docs);
  const raw = contentTerms(query);
  const terms: string[] = [];
  const unmatched: string[] = [];

  for (const term of raw) {
    if (index.vocab.has(term)) {
      terms.push(term);
      continue;
    }
    const corrected = resolveTypo(term, index.vocab);
    if (corrected) terms.push(corrected);
    else unmatched.push(term);
  }

  const scores = new Map<string, number>();
  if (terms.length === 0) return { scores, terms, unmatched };

  for (const doc of docs) {
    const counts = index.tf.get(doc.id);
    const dl = index.len.get(doc.id) ?? 0;
    if (!counts || dl === 0) continue;

    let score = 0;
    for (const term of terms) {
      const f = counts.get(term) ?? 0;
      if (f === 0) continue;
      const n = index.df.get(term) ?? 0;
      // +1 inside the log keeps IDF non-negative when a term is in every chunk,
      // which matters on a small corpus where that is common.
      const idf = Math.log(1 + (index.size - n + 0.5) / (n + 0.5));
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / index.avgLen));
    }
    if (score > 0) scores.set(doc.id, score);
  }
  return { scores, terms, unmatched };
}

/** Saturating map of an unbounded BM25 score into [0,1) for fusion. */
export function saturate(score: number, half = 2.5): number {
  return score <= 0 ? 0 : score / (score + half);
}

/** Fraction of the query's content terms present in a document. Drives confidence. */
export function termCoverage(query: string, docId: string, docs: LexDoc[]): number {
  const index = buildIndex(docs);
  const raw = contentTerms(query);
  if (raw.length === 0) return 0;
  const counts = index.tf.get(docId);
  if (!counts) return 0;
  let found = 0;
  for (const term of raw) {
    const resolved = index.vocab.has(term) ? term : resolveTypo(term, index.vocab);
    if (resolved && (counts.get(resolved) ?? 0) > 0) found++;
  }
  return found / raw.length;
}
