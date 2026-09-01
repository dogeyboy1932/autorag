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
 * `want` is the source id that should rank first.
 *  - `null`  — any source is defensible; ranking is not scored.
 *  - `NONE`  — the corpus cannot answer this; the app must say so.
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
   * Must be reported as uncovered.
   *
   * "how long is it" is in this group deliberately, and it is the most
   * instructive row in the file. It *feels* answerable — the corpus does contain
   * the runtime. But the query has no subject, and the word "long" appears
   * nowhere in the corpus, so its top dense score is 0.139 — identical to
   * "how do I bake sourdough", which scores 0.139 with a *larger* margin.
   *
   * The two are indistinguishable at the signal level. Ranking Wikipedia first
   * is coincidence at the noise floor, not knowledge, and reporting confidence
   * from it would be exactly the overclaim this project avoids everywhere else.
   * Low confidence is the correct answer here, not a bug to fix.
   */
  ['under-specified', 'how long is it',        'NONE'],
  ['off-topic',       'capital of Mongolia',   'NONE'],
  ['off-topic',       'how do I bake sourdough', 'NONE'],
  ['off-topic',       'python list comprehension', 'NONE'],
];
