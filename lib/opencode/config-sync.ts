import fs from 'node:fs';
import path from 'node:path';

export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const d = text[i];
        out += d;
        i++;
        if (d === '\\' && i < n) { out += text[i]; i++; }
        else if (d === '"') break;
      }
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else if (c === ',') {
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') { while (j < n && text[j] !== '\n') j++; }
        else if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
        } else break;
      }
      if (text[j] === '}' || text[j] === ']') { i++; } else { out += c; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function buildConfig(
  userConfigText: string | null,
  opts: { importProviders: boolean },
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    default_agent: 'scotty',
    update: 'disable',
    policies: [{ action: 'tool.use', resource: 'shell:git push *', effect: 'deny' }],
  };
  if (opts.importProviders && userConfigText) {
    try {
      const parsed = JSON.parse(stripJsonc(userConfigText));
      if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
        config.providers = parsed.providers;
      }
    } catch {
      // unparseable user config: fall back to the base config
    }
  }
  return config;
}

const SKIP = new Set(['node_modules', '.DS_Store']);
const copyFilter = (src: string) => {
  if (SKIP.has(path.basename(src))) return false;
  try {
    fs.statSync(src); // follows links; dangling links are skipped
    return true;
  } catch {
    return false;
  }
};

// Symlinks are dereferenced so the target only ever holds real files/dirs and
// later writes can never travel through a link into the user's directory.
function copyDir(from: string, to: string) {
  try {
    if (!fs.statSync(from).isDirectory()) return;
    fs.cpSync(from, to, { recursive: true, dereference: true, filter: copyFilter });
  } catch {
    // unreadable, not a directory, or a symlink loop: skip this source
  }
}

function removeLink(p: string) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p, { force: true });
  } catch {
    // absent
  }
}

function realDirInside(root: string, dir: string) {
  removeLink(dir);
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  if (path.relative(fs.realpathSync(root), real).startsWith('..')) {
    throw new Error(`refusing to write outside ${root}`);
  }
}

export function syncConfigDir(opts: {
  userDir: string;
  targetDir: string;
  assetsDir: string;
  importUser: boolean;
}): void {
  const { userDir, targetDir, assetsDir, importUser } = opts;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of ['agents', 'skills', 'opencode.jsonc']) {
    fs.rmSync(path.join(targetDir, name), { recursive: true, force: true });
  }

  let userConfigText: string | null = null;
  if (importUser) {
    for (const sub of ['agents', 'skills']) {
      copyDir(path.join(userDir, sub), path.join(targetDir, sub));
    }
    for (const f of ['opencode.jsonc', 'opencode.json']) {
      try {
        userConfigText = fs.readFileSync(path.join(userDir, f), 'utf8');
        break;
      } catch {
        // try next
      }
    }
  }
  for (const sub of ['agents', 'skills']) {
    realDirInside(targetDir, path.join(targetDir, sub));
    copyDir(path.join(assetsDir, sub), path.join(targetDir, sub));
  }
  removeLink(path.join(targetDir, 'opencode.jsonc'));
  fs.writeFileSync(
    path.join(targetDir, 'opencode.jsonc'),
    JSON.stringify(buildConfig(userConfigText, { importProviders: importUser }), null, 2) + '\n',
    { mode: 0o600 },
  );
}
