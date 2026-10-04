/**
 * Capture a browsing session as a request trace that `blockingmachine coverage --trace` can
 * replay *with paths*.
 *
 * Paste this whole file into devtools on each page of a session and run it. It prints one line
 * per distinct request URL, which is exactly the trace format: a target, an optional trailing
 * count, `#` and `!` for comments. Redirect the output into one file across the session:
 *
 *   blockingmachine coverage --trace trace.txt
 *
 * Why this exists. `performance.getEntriesByType('resource')` has always handed back full URLs;
 * the fixture trace this project measures itself against kept only the hostname of each one,
 * because that was all a hostname replay could use. A hostname decides zone blocks and nothing
 * else, so every path-scoped rule in the list was reported as a rule "a replay cannot decide" —
 * which is true, and was also a statement about the shape of the capture rather than about the
 * list. Replaying URLs turns those rules into measurements. The collector is the reason the
 * next measurement can differ from the last one.
 *
 * What it deliberately records: the requested URL, and how many times it was requested. What it
 * does not: referrer, initiator, response body, headers, or any timing beyond the count. The
 * trace is read offline by the training scripts on the machine that captured it, so it needs to
 * carry enough to decide a rule and nothing more.
 */
(() => {
  const entries =
    typeof performance !== 'undefined' && performance.getEntriesByType
      ? performance.getEntriesByType('resource')
      : [];

  const totals = new Map();
  for (const entry of entries) {
    const url = typeof entry?.name === 'string' ? entry.name : '';
    // A fragment never leaves the browser, so two URLs differing only in one are one request.
    const clean = url.split('#')[0];
    if (!/^https?:/i.test(clean)) continue;
    totals.set(clean, (totals.get(clean) ?? 0) + 1);
  }

  const page = typeof location !== 'undefined' ? location.href : '(unknown page)';
  console.log(`# page: ${page}`);
  if (totals.size === 0) {
    console.log('# (no resource entries — nothing was requested, or the page is still loading)');
    return;
  }
  // Sorted so two captures of the same session diff cleanly.
  for (const [url, count] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Tab-separated count. A real URL never contains whitespace — the browser percent-encodes
    // it — so the parser's "last field is a count" rule cannot eat part of the target.
    console.log(`${url}\t${count}`);
  }
  console.log(`# ${totals.size} distinct URLs`);
})();
