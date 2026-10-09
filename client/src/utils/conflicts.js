// e.g. "photos/2024/a.jpg" -> "photos", "report.pdf" -> "report.pdf"
export function topLevelName(relPath) {
  return String(relPath).split('/')[0];
}

// Ignores a trailing slash: "/a/" === "/a".
export function samePath(a, b) {
  const norm = (p) => String(p).replace(/\/+$/, '') || '/';
  return norm(a) === norm(b);
}

// A dropped group is a folder when any of its entries live below the top-level segment.
function isFolderGroup(entries, top) {
  return entries.some((e) => {
    const segs = e.path.split('/');
    return segs[0] === top && segs.length > 1;
  });
}

// "report.pdf" -> "report-1.pdf"; folders and extensionless names get a plain "-1".
function suffixedName(name, isFolder, n) {
  if (isFolder) return `${name}-${n}`;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-${n}`; // no extension, or a leading-dot file like ".env"
  return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}

function freeName(name, isFolder, used) {
  let n = 1;
  let candidate;
  do {
    candidate = suffixedName(name, isFolder, n);
    n += 1;
  } while (used.has(candidate.toLowerCase()));
  return candidate;
}

// decisions: { [topLevelName]: 'replace' | 'skip' | 'rename' }. Returns the entries to upload
// (skips removed, renames rewritten) and toDelete, the top-level names being replaced.
export function applyConflictResolutions(entries, decisions, existingNames) {
  // Lowercased for case-insensitive (Windows) comparison.
  const used = new Set((existingNames || []).map((n) => n.toLowerCase()));
  // Reserve this drop's own top-level names so a rename can't collide with a sibling upload.
  entries.forEach((e) => used.add(topLevelName(e.path).toLowerCase()));

  const renameMap = new Map(); // oldTop -> newTop
  const skip = new Set();
  const toDelete = [];

  for (const [name, action] of Object.entries(decisions)) {
    if (action === 'skip') {
      skip.add(name);
    } else if (action === 'replace') {
      toDelete.push(name);
    } else if (action === 'rename') {
      const newName = freeName(name, isFolderGroup(entries, name), used);
      used.add(newName.toLowerCase());
      renameMap.set(name, newName);
    }
  }

  const finalEntries = [];
  for (const e of entries) {
    const segs = e.path.split('/');
    const top = segs[0];
    if (skip.has(top)) continue;
    if (renameMap.has(top)) {
      segs[0] = renameMap.get(top);
      finalEntries.push({ ...e, path: segs.join('/') });
    } else {
      finalEntries.push(e);
    }
  }

  return { finalEntries, toDelete };
}
