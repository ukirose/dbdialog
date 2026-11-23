import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * Calls onChange shortly after the file changes. The folder is watched, not
 * the file: editors often save by writing a new file and renaming it over the
 * old one, and a watch on the old file would stop seeing changes.
 */
export function watchFile(path: string, onChange: () => void, delayMs = 30): () => void {
  const name = basename(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher: FSWatcher = watch(dirname(path), (_event, filename) => {
    if (filename && filename.toString() !== name) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, delayMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
