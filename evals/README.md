# Evaluations

Ten questions over a fixed seed corpus, each answerable only by calling Autorag's
tools. They test **the tool surface**, not the model: if an agent picks the wrong
arguments or misreads a result, the description is at fault.

## Running them

1. Open the app and let the embedding model finish loading.
2. Seed the corpus: paste `seed-corpus.json` entries through
   `autorag_ingest_passage`, approve all, then mark the JustWatch source stale with
   the reason recorded in the file.
3. Point an agent at the page with only the tool descriptions to go on — no hints
   about which tool to use.
4. Compare answers to `autorag_eval.xml` by string match.

## What a failure means

| Symptom | Likely cause |
|---|---|
| Agent picks the wrong tool | Two descriptions overlap; sharpen the distinction |
| Agent passes wrong arguments | A field description is ambiguous or missing a unit |
| Agent reports success on an error | The error payload reads as a result; check `ok:false` shape |
| Agent gives up after an empty result | The tool did not suggest a next step |

The last row is why every error carries `suggested_next_tool`.
