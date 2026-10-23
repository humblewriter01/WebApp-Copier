/**
 * The contract between a statement's placeholders and the values bound to it.
 *
 * Postgres prepares a statement with exactly one parameter slot per `$n` it finds in the text, and it
 * rejects a bind whose value count differs - `bind message supplies 5 parameters, but prepared
 * statement "" requires 4`. That error is raised by the driver, several calls away from the code that
 * assembled the two halves, so a statement built from fragments (or from a conditional expression that
 * only *sometimes* mentions `$5`) fails in production and reads like a database problem. Checking the
 * pair where it is built turns it into an error that names the query instead.
 */
const PLACEHOLDER = /\$\d+/g;

/**
 * How many slots the statement asks for, and which ones the text actually uses. `$1` appearing twice
 * is one slot used twice, so the count Postgres prepares is the highest number, not the number of
 * matches - and a gap in the numbering is reported because it is always a build mistake.
 */
export function countQueryParameters(sql) {
  const text = String(sql ?? '');
  const matches = text.match(PLACEHOLDER) || [];
  const used = new Set(matches.map((token) => Number(token.slice(1))));
  const max = used.size ? Math.max(...used) : 0;
  return {
    count: max,
    occurrences: matches.length,
    used: [...used].sort((left, right) => left - right),
    unreferenced: max ? Array.from({ length: max }, (_value, index) => index + 1).filter((position) => !used.has(position)) : [],
  };
}

/**
 * Throws when a statement and its values disagree; otherwise returns the shape, so a caller can log
 * what it checked. A call with no values has nothing to compare, and a statement with no placeholders
 * is legal with an empty array, so both pass.
 */
export function assertQueryParameters(sql, values, label = 'query') {
  const shape = countQueryParameters(sql);
  if (values === undefined || values === null) return { ...shape, values: 0, checked: false };
  if (!Array.isArray(values)) return { ...shape, values: null, checked: false };
  if (shape.count === values.length) return { ...shape, values: values.length, checked: true };
  const error = new Error(
    `${label} binds ${shape.count} parameter${shape.count === 1 ? '' : 's'} ($1-$${shape.count}) but `
    + `${values.length} value${values.length === 1 ? '' : 's'} ${values.length === 1 ? 'was' : 'were'} supplied`
    + (shape.unreferenced.length ? `; the statement never mentions $${shape.unreferenced.join(', $')}` : ''),
  );
  error.code = 'QUERY_PARAMETER_MISMATCH';
  error.sql = String(sql ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  throw error;
}

/** Normalizes the two shapes `pg` accepts: `(text, values)` and `({ text, values })`. */
export function queryArguments(target, rest = []) {
  if (typeof target === 'string') return { sql: target, values: rest[0] };
  if (target && typeof target === 'object' && !Array.isArray(target) && ('text' in target || 'query' in target)) {
    return { sql: target.text ?? target.query, values: target.values };
  }
  return { sql: null, values: undefined };
}

/**
 * Wraps a `pg` pool or client so every statement is checked before it is sent. The check is one regex
 * over a short string per query; against a round trip to the database that costs nothing, and it
 * turns an opaque driver error into one that names the query that caused it.
 */
export function withParameterChecks(target, label = 'query') {
  if (!target || typeof target.query !== 'function' || target.__parameterChecksWrapped === true) return target;
  const originalQuery = target.query.bind(target);
  const originalConnect = typeof target.connect === 'function' ? target.connect.bind(target) : null;

  target.query = function checkedQuery(...args) {
    const { sql, values } = queryArguments(args[0], args.slice(1));
    if (sql) assertQueryParameters(sql, values, label);
    return originalQuery(...args);
  };

  // A transaction talks to a client borrowed from the pool, so that client needs the same contract:
  // the manual subscription adjustment runs entirely through one, which is where a mismatch hid.
  if (originalConnect) {
    target.connect = async function checkedConnect(...args) {
      const client = await originalConnect(...args);
      withParameterChecks(client, `${label} (client)`);
      return client;
    };
  }
  Object.defineProperty(target, '__parameterChecksWrapped', { value: true, enumerable: false });
  return target;
}
