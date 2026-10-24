/**
 * Splitting the schema string into statements that can be sent one at a time.
 *
 * `server/db.js` holds the whole schema as one long piece of text, which is a good way to write it and a
 * terrible way to send it. A multi-statement string reaches Postgres as a single implicit transaction, so
 * every `ALTER TABLE` in it grabs an ACCESS EXCLUSIVE lock at the start and holds all of them until the
 * last statement commits. One other session holding a plain read on any of those tables - the worker's
 * claim loop, a dashboard query, the instance that is still serving traffic while a deploy waits to be
 * marked healthy - parks the entire migration behind that lock, and because nothing in the app has a
 * `lock_timeout`, it parks the boot with it. The port is never opened, no error is ever printed, and the
 * only evidence is a host timing out fifteen minutes later.
 *
 * So the text is split and each statement runs alone: same order, same effect, but each lock is taken and
 * released a hundred small times instead of once for the whole file, and a statement that cannot get its
 * lock can be waited on briefly, retried, and finally *named* in an error.
 *
 * Splitting on `;` is not enough, and the reasons are all present in the real schema: a `DO $$ BEGIN ...
 * END $$;` body contains semicolons, a `--` or block comment can contain one, and a string literal such as
 * `role IN ('user', 'admin')` must never be mistaken for the end of a statement. This scanner tracks those
 * contexts and cuts only at a semicolon that sits in bare code.
 */

/** `$tag$ ... $tag$` opens with a dollar sign, an optional tag of letters/digits/underscore, another dollar. */
const DOLLAR_TAG = /^\$[A-Za-z_0-9]*\$/;

/**
 * Cut a SQL string into executable statements. Comments are dropped, since Postgres needs none of them
 * and a stray semicolon in prose should not be able to chop a statement in half.
 */
export function splitSchemaStatements(sql) {
  const text = String(sql ?? '');
  const statements = [];
  let current = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const two = rest.slice(0, 2);
    if (two === '--') {
      index = endOfLine(text, index);
      continue;
    }
    if (two === '/*') {
      const closed = text.indexOf('*/', index + 2);
      index = closed === -1 ? text.length : closed + 2;
      continue;
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      const [literal, next] = readQuoted(text, index, quote);
      current += literal;
      index = next;
      continue;
    }
    const tag = rest.match(DOLLAR_TAG)?.[0];
    if (tag) {
      const closing = text.indexOf(tag, index + tag.length);
      const end = closing === -1 ? text.length : closing + tag.length;
      current += text.slice(index, end);
      index = end;
      continue;
    }
    if (rest[0] === ';') {
      push(statements, current);
      current = '';
      index += 1;
      continue;
    }
    current += rest[0];
    index += 1;
  }
  push(statements, current);
  return statements;
}

/** A quoted run of text, honouring the SQL doubling of the quote character (`it''s`). */
function readQuoted(text, start, quote) {
  let index = start + 1;
  let out = quote;
  while (index < text.length) {
    const char = text[index];
    if (char === quote) {
      if (text[index + 1] === quote) {
        out += quote + quote;
        index += 2;
        continue;
      }
      return [out + quote, index + 1];
    }
    out += char;
    index += 1;
  }
  // An unterminated quote is a broken schema file, not something to guess around: hand the rest back and
  // let Postgres (and the syntax sweep) reject the statement it belongs to.
  return [out, index];
}

function endOfLine(text, from) {
  const newline = text.indexOf('\n', from);
  return newline === -1 ? text.length : newline;
}

function push(statements, raw) {
  const statement = raw.trim();
  if (statement) statements.push(statement);
}

/** One line, shortened, for a log line or an error message: never the whole 400-line schema. */
export function sqlPreview(sql, max = 180) {
  const flat = String(sql ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A promise that must not be allowed to become a silent wait.
 *
 * The database can be reachable-but-unanswered, which is the one failure a TCP timeout does not cover:
 * the socket opens, the startup packet goes out, nothing comes back, and `pg` waits because waiting is
 * what a driver does. The caller therefore races the work against a deadline, and `onLate` gets the value
 * if it arrives afterwards, so an abandoned connection checkout is released instead of leaking a slot.
 */
export async function withDeadline(work, timeoutMs, label, { onLate } = {}) {
  const limit = Math.max(1, Math.round(Number(timeoutMs) || 0)) || 1;
  let expired = false;
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const error = new Error(`Timed out after ${limit} ms waiting for ${label}`);
      error.code = 'BOOT_DEADLINE_EXCEEDED';
      error.timeoutMs = limit;
      reject(error);
    }, limit);
  });
  const tracked = Promise.resolve(work);
  if (typeof onLate === 'function') tracked.then((value) => { if (expired) onLate(value); }, () => {});
  try {
    return await Promise.race([tracked, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    // The loser of the race still has to be regarded, or a rejection nobody sees becomes a process warning.
    tracked.catch(() => {});
  }
}

/** Coerced number for a `SET` statement, so an environment value can never smuggle SQL. */
export function timeoutSetting(value, fallbackMs) {
  const parsed = Number(value);
  const ms = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : Math.round(fallbackMs);
  return `${ms}ms`;
}
