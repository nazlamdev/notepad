// Text editing helpers for a <textarea>. Edits go through execCommand('insertText')
// so the browser's native undo/redo stack keeps working.

type TA = HTMLTextAreaElement;

const lineStart = (v: string, pos: number) => v.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (v: string, pos: number) => {
  const i = v.indexOf('\n', pos);
  return i === -1 ? v.length : i;
};

/** Start/end offsets of the full lines touched by the selection (end excludes the trailing newline). */
function selectedLines(ta: TA) {
  const { value: v, selectionStart: s, selectionEnd: e } = ta;
  const start = lineStart(v, s);
  const endPos = e > s && v[e - 1] === '\n' ? e - 1 : e;
  return { start, end: lineEnd(v, endPos), s, e, v };
}

export function replace(ta: TA, start: number, end: number, text: string, selStart?: number, selEnd?: number): void {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = text ? document.execCommand('insertText', false, text) : start === end || document.execCommand('delete');
  } catch {
    ok = false;
  }
  if (!ok) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
}

function mapLines(ta: TA, fn: (line: string) => string) {
  const { start, end, s, e, v } = selectedLines(ta);
  const before = v.slice(start, end);
  const lines = before.split('\n');
  const mapped = lines.map(fn);
  const after = mapped.join('\n');
  const firstDelta = mapped[0].length - lines[0].length;
  const newS = Math.max(start, s + firstDelta);
  const newE = s === e ? newS : Math.max(newS, e + (after.length - before.length));
  replace(ta, start, end, after, newS, newE);
}

export function indent(ta: TA): void {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  if (s === e || !v.slice(s, e).includes('\n')) {
    replace(ta, s, e, '\t');
    return;
  }
  mapLines(ta, (l) => '\t' + l);
}

export function indentLines(ta: TA): void {
  mapLines(ta, (l) => '\t' + l);
}

export function outdent(ta: TA): void {
  mapLines(ta, (l) => l.replace(/^(\t| {1,4})/, ''));
}

export function duplicateLine(ta: TA): void {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  if (s !== e) {
    replace(ta, e, e, v.slice(s, e), e, e + (e - s));
    return;
  }
  const ls = lineStart(v, s);
  const le = lineEnd(v, s);
  const line = v.slice(ls, le);
  replace(ta, le, le, '\n' + line, s + line.length + 1);
}

export function deleteLine(ta: TA): void {
  const { start, end, v } = selectedLines(ta);
  if (end < v.length) replace(ta, start, end + 1, '', start);
  else if (start > 0) replace(ta, start - 1, end, '', lineStart(v, start - 1));
  else replace(ta, start, end, '', 0);
}

export function selectLine(ta: TA): void {
  const { start, end, v } = selectedLines(ta);
  ta.setSelectionRange(start, Math.min(v.length, end + 1));
}

export function insertLine(ta: TA, above: boolean): void {
  const { value: v, selectionStart: s } = ta;
  const ls = lineStart(v, s);
  const indentStr = /^[\t ]*/.exec(v.slice(ls))![0];
  if (above) replace(ta, ls, ls, indentStr + '\n', ls + indentStr.length);
  else {
    const le = lineEnd(v, s);
    replace(ta, le, le, '\n' + indentStr, le + 1 + indentStr.length);
  }
}

export function moveLines(ta: TA, dir: -1 | 1): void {
  const { start, end, s, e, v } = selectedLines(ta);
  const block = v.slice(start, end);
  if (dir < 0) {
    if (start === 0) return;
    const ps = lineStart(v, start - 1);
    const prev = v.slice(ps, start - 1);
    replace(ta, ps, end, block + '\n' + prev, s - prev.length - 1, e - prev.length - 1);
  } else {
    if (end >= v.length) return;
    const ne = lineEnd(v, end + 1);
    const next = v.slice(end + 1, ne);
    replace(ta, start, ne, next + '\n' + block, s + next.length + 1, e + next.length + 1);
  }
}

const CHECK_RE = /^(\s*)- \[[ xX]\] /;

/** Apple Notes style checklist toggle (⌘⇧L): adds/removes "- [ ] " on the selected lines. */
export function toggleChecklist(ta: TA): void {
  const { start, end, v } = selectedLines(ta);
  const lines = v.slice(start, end).split('\n');
  const allChecklist = lines.every((l) => CHECK_RE.test(l) || !l.trim());
  mapLines(ta, (l) => {
    if (allChecklist) return l.replace(CHECK_RE, '$1');
    if (CHECK_RE.test(l) || !l.trim()) return l;
    if (/^(\s*)[-*•] /.test(l)) return l.replace(/^(\s*)[-*•] /, '$1- [ ] ');
    return l.replace(/^(\s*)/, '$1- [ ] ');
  });
}

/** Mark checklist items done/undone. */
export function toggleChecked(ta: TA): void {
  const { start, end, v } = selectedLines(ta);
  const lines = v.slice(start, end).split('\n').filter((l) => CHECK_RE.test(l));
  if (!lines.length) return;
  const allDone = lines.every((l) => /- \[[xX]\] /.test(l));
  mapLines(ta, (l) => (CHECK_RE.test(l) ? l.replace(/- \[[ xX]\] /, allDone ? '- [ ] ' : '- [x] ') : l));
}

/**
 * Enter: continue lists/checklists and keep indentation. Returns false when the
 * default behaviour should run.
 */
export function smartEnter(ta: TA): boolean {
  const { value: v, selectionStart: s, selectionEnd: e } = ta;
  if (s !== e) return false;
  const ls = lineStart(v, s);
  const before = v.slice(ls, s);
  const m = /^(\s*)(- \[[ xX]\] |[-*•] |(\d+)[.)] )?/.exec(before)!;
  const [prefix, ws, marker, num] = m;
  if (!prefix) return false;
  if (marker && before === prefix && lineEnd(v, s) === s) {
    // Empty list item: end the list.
    replace(ta, ls, s, ws, ls + ws.length);
    return true;
  }
  let next = ws;
  if (marker) {
    if (marker.startsWith('- [')) next += '- [ ] ';
    else if (num) next += `${Number(num) + 1}${marker.slice(num.length)}`;
    else next += marker;
  }
  replace(ta, s, s, '\n' + next);
  return true;
}
