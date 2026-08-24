import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const BACKUP_NAME = /^memecoin_alpha_[A-Za-z0-9_.-]+\.dump$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface BackupHealthEvidence {
  available: boolean;
  filename: string | null;
  bytes: number | null;
  createdAt: string | null;
  ageSeconds: number | null;
  sidecarPresent: boolean;
  offsiteAcknowledged: boolean;
  sha256: string | null;
  reason?: string;
}

export async function inspectBackupDirectory(
  directory: string,
  now = new Date()
): Promise<BackupHealthEvidence> {
  try {
    const names = (await readdir(directory)).filter((name) => BACKUP_NAME.test(name));
    const candidates = await Promise.all(
      names.map(async (filename) => ({ filename, file: await stat(join(directory, filename)) }))
    );
    const newest = candidates
      .filter((candidate) => candidate.file.isFile())
      .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)[0];
    if (!newest) {
      return unavailable("no-completed-backup");
    }
    const backupPath = join(directory, newest.filename);
    const sidecar = await readOptional(`${backupPath}.sha256`);
    const marker = await readOptional(`${backupPath}.offsite-verified`);
    const sidecarSha = sidecar?.trim().split(/\s+/u)[0]?.toLowerCase() ?? null;
    const acknowledgedSha =
      marker
        ?.split(/\r?\n/u)
        .find((line) => line.startsWith("sha256="))
        ?.slice("sha256=".length)
        .trim()
        .toLowerCase() ?? null;
    const validSidecar = Boolean(sidecarSha && SHA256.test(sidecarSha));
    return {
      available: true,
      filename: newest.filename,
      bytes: newest.file.size,
      createdAt: newest.file.mtime.toISOString(),
      ageSeconds: Math.max(0, (now.getTime() - newest.file.mtimeMs) / 1_000),
      sidecarPresent: validSidecar,
      offsiteAcknowledged: Boolean(
        validSidecar && acknowledgedSha && sidecarSha === acknowledgedSha
      ),
      sha256: validSidecar ? sidecarSha : null,
      ...(!validSidecar
        ? { reason: "missing-or-invalid-sha256-sidecar" }
        : acknowledgedSha !== sidecarSha
          ? { reason: "offsite-acknowledgement-missing-or-mismatched" }
          : {})
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message.slice(0, 200) : "backup-read-failed");
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function unavailable(reason: string): BackupHealthEvidence {
  return {
    available: false,
    filename: null,
    bytes: null,
    createdAt: null,
    ageSeconds: null,
    sidecarPresent: false,
    offsiteAcknowledged: false,
    sha256: null,
    reason
  };
}
