import type * as Fs from 'fs/promises';
import type * as Path from 'path';

/** Reject recursive copies, including directories reached through symlinks. */
export async function assertSafeDirectoryImport(
  source: string, targetFolder: string,
  fs: Pick<typeof Fs, 'realpath'>, path: Pick<typeof Path, 'relative' | 'isAbsolute' | 'sep'>,
): Promise<void> {
  const [realSource, realTarget] = await Promise.all([fs.realpath(source), fs.realpath(targetFolder)]);
  const relative = path.relative(realSource, realTarget);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('A directory cannot be imported into itself or one of its subfolders.');
  }
}
