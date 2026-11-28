// Node 24 TAP reporter: accept exactly one top-level result and one summary.
export function selectedTapPassed(tap, caseId) {
  const lines = tap.split(/\r?\n/);
  const results = lines.filter(line => /^(?:ok|not ok) \d+ - /.test(line));
  const plans = lines.filter(line => /^1\.\.\d+(?:\s|$)/.test(line));
  if (results.length !== 1 || results[0] !== `ok 1 - ${caseId}` || plans.length !== 1 || plans[0] !== '1..1') return false;
  const expected = { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const [key, value] of Object.entries(expected)) {
    const records = lines.filter(line => new RegExp(`^# ${key} \\d+$`).test(line));
    if (records.length !== 1 || records[0] !== `# ${key} ${value}`) return false;
  }
  return true;
}
