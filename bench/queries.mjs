/**
 * Retrieval benchmark fixtures.
 *
 * Four sources, each the correct answer for a different kind of question, and a
 * query set written to look like what an ordinary person types — single words,
 * bare numbers, typos, and half-sentences — not the tidy full questions that
 * dense embeddings happen to be good at.
 */

export const SEED = [
  ['wiki', 'https://en.wikipedia.org/wiki/Dune:_Part_Two', 'Dune: Part Two - Wikipedia',
   'Dune: Part Two is a 2024 epic science fiction film directed by Denis Villeneuve, who co-wrote the screenplay with Jon Spaihts. The sequel to Dune, it adapts the second half of the 1965 novel by Frank Herbert. It has a runtime of 166 minutes and was distributed by Warner Bros. Pictures. Principal photography took place in Hungary, Italy, Jordan and Abu Dhabi.'],
  ['justwatch', 'https://www.justwatch.com/us/movie/dune-part-two', 'Dune: Part Two - JustWatch',
   'Dune: Part Two is currently available to stream on Max in the United States. It is also available to rent or buy from Amazon Video, Apple TV and Fandango at Home. It is not available on Netflix or Hulu. Availability last verified August 2026.'],
  ['rt', 'https://www.rottentomatoes.com/m/dune_part_two', 'Dune: Part Two - Rotten Tomatoes',
   'Dune: Part Two holds a 92 percent critical aggregate score based on over 500 reviews. The audience score sits at 95 percent. The film is rated PG-13 for sequences of strong violence and some suggestive material.'],
  ['cast', 'https://example.test/dune-cast', 'Dune: Part Two - full cast',
   'Timothee Chalamet stars as Paul Atreides and Zendaya plays Chani. Rebecca Ferguson returns as Lady Jessica, with Austin Butler as Feyd-Rautha and Florence Pugh as Princess Irulan. Javier Bardem plays Stilgar.'],
];

/**
 * Each row is `[shape, query, want]`.
 *
 * `want` is the source id that should rank **first**:
 *  - a source id — that source must lead
 *  - `null`      — several answers are defensible; ranking not scored
 *  - `NONE`      — the corpus genuinely contains nothing relevant
 *
 * Note what is *not* asserted anywhere here: that the app should refuse to
 * answer. Autorag has no language model and cannot see the caller's
 * conversation, so deciding a question is unanswerable is not its call to make
 * (build plan AD-1). It returns passages and honest signals; the agent judges.
 */
export const QUERIES = [
  ['single word',   'dune',                              null],
  ['single word',   'netflix',                           'justwatch'],
  ['single word',   'runtime',                           'wiki'],
  ['single word',   'villeneuve',                        'wiki'],
  ['single word',   'zendaya',                           'cast'],
  ['bare number',   '166',                               'wiki'],
  ['bare token',    'PG-13',                             'rt'],
  ['bare token',    'Fandango',                          'justwatch'],
  ['keywords',      'dune runtime',                      'wiki'],
  ['keywords',      'dune streaming max',                'justwatch'],
  ['keywords',      'dune cast actors',                  'cast'],
  ['keywords',      'rotten tomatoes score',             'rt'],
  ['typo',          'villenueve',                        'wiki'],
  ['typo',          'dune part to runtime',              'wiki'],
  ['casual',        'who plays chani',                   'cast'],
  ['casual',        'is dune on netflix',                'justwatch'],
  ['casual',        'whats the rating',                  'rt'],
  ['full question', 'Who directed Dune: Part Two?',      'wiki'],
  ['full question', 'Where can I stream Dune Part Two?', 'justwatch'],
  ['full question', 'What did critics score it?',        'rt'],

  /*
   * Under-specified follow-ups. The corpus *does* answer these — but only if you
   * know what "it" refers to, which Autorag never does and the calling agent
   * always does. So the passage must still come back ranked first, the score
   * will be low, and the note must say the query carries no terms of its own
   * rather than telling the agent to give up.
   */
  ['under-specified', 'how long is it',            'wiki'],
  ['under-specified', 'what did they score it',    'rt'],

  /* Genuinely absent from the corpus. Passages still come back — the agent is
   * never left empty-handed — but the match must not be reported as strong. */
  ['off-topic',       'capital of Mongolia',       'NONE'],
  ['off-topic',       'how do I bake sourdough',   'NONE'],
  ['off-topic',       'python list comprehension', 'NONE'],
];
