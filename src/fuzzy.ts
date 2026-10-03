export interface FuzzyMatch {
  score: number;
  indices: number[];
}

/** Subsequence matcher in the spirit of "Goto Anything": rewards consecutive and word-start hits. */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    let s = 1;
    if (found === prev + 1) s += 5;
    if (found === 0 || /[\s\-_/.()]/.test(t[found - 1])) s += 3;
    s -= Math.min(found - ti, 10) * 0.1;
    score += s;
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  score -= text.length * 0.01;
  return { score, indices };
}

export function highlight(text: string, indices: number[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const set = new Set(indices);
  let buf = '';
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) {
      const m = document.createElement('mark');
      m.textContent = buf;
      frag.append(m);
    } else frag.append(buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== inMark) {
      flush();
      inMark = hit;
    }
    buf += text[i];
  }
  flush();
  return frag;
}
