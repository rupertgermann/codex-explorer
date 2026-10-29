import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

/** Resolve existing ancestors before allowing backups outside the Memory corpus. */
export function assertExternalMemoryBackup(root: string, backupRoot: string) {
  let parent = backupRoot;
  while (!existsSync(parent)) parent = dirname(parent);
  const backup = resolve(realpathSync(parent), relative(parent, backupRoot));
  const corpus = realpathSync(root);
  if (backup === corpus || backup.startsWith(`${corpus.endsWith(sep) ? corpus : corpus + sep}`)) {
    throw new Error("Forget backups must be stored outside the Memory corpus.");
  }
}
