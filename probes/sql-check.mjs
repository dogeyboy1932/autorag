/**
 * Does the SQL the panel hands people match the SQL in the repo?
 *
 *   pnpm sql:check
 *
 * `supabase/corpus.sql` is the file a person reads, and `SCHEMA_SQL` in
 * src/rag/sync.ts is the string the side panel puts in front of them with a Copy
 * button. They are the same script in two places because the panel cannot read a
 * file at runtime and the repo should not hide its schema inside a TypeScript
 * constant.
 *
 * Two copies drift. The failure is quiet and lands on a stranger: someone copies
 * the panel's version into their own project, gets a schema one policy short of
 * the one the code expects, and the symptom arrives later as rows that sync but
 * cannot be read back. So this asserts they are character-identical, minus the
 * file's own header comment, which exists to tell a human which project to run it
 * in and would be noise inside the panel.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = readFileSync(resolve(root, 'supabase/corpus.sql'), 'utf8').replace(/\n+$/, '');
const ts = readFileSync(resolve(root, 'src/rag/sync.ts'), 'utf8');

// The header runs until the first statement; everything after is the shared body.
const lines = file.split('\n');
let i = 0;
while (i < lines.length && (lines[i].startsWith('--') || !lines[i].trim())) i++;
const body = lines.slice(i).join('\n').trim();

/*
 * A backtick in the .sql file terminates the template literal it is embedded in,
 * and the result is a TypeScript syntax error hundreds of lines from the edit
 * that caused it. Twice now a markdown habit in a SQL comment has done exactly
 * that, so it is checked here rather than remembered.
 */
if (body.includes('`') || body.includes('${')) {
  console.error(
    'FAIL  supabase/corpus.sql contains a backtick or ${ — it is embedded in a TypeScript\n' +
      '      template literal, so either one breaks the build. Use plain words in SQL comments.',
  );
  process.exit(1);
}

const match = ts.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
if (!match) {
  console.error('FAIL  SCHEMA_SQL not found in src/rag/sync.ts');
  process.exit(1);
}
const embedded = match[1].trim();

if (embedded === body) {
  console.log(`PASS  supabase/corpus.sql and SCHEMA_SQL agree (${body.length} chars)`);
  process.exit(0);
}

console.error('FAIL  supabase/corpus.sql and SCHEMA_SQL have drifted.\n');
const a = body.split('\n');
const b = embedded.split('\n');
for (let n = 0; n < Math.max(a.length, b.length); n++) {
  if (a[n] !== b[n]) {
    console.error(`  first difference at line ${n + 1}:`);
    console.error(`    corpus.sql: ${a[n] ?? '(end of file)'}`);
    console.error(`    SCHEMA_SQL: ${b[n] ?? '(end of string)'}`);
    break;
  }
}
console.error('\n  corpus.sql is the one to edit; then re-embed it into SCHEMA_SQL.');
process.exit(1);
