export interface RuntimeFilePreviewEntry {
  id: string;
  content?: string | null;
  error?: string | null;
  truncated?: boolean | null;
}

export function runtimeFileNeedsContentLoad(
  file: RuntimeFilePreviewEntry | null | undefined,
  loadingFileId?: string | null,
): file is RuntimeFilePreviewEntry {
  return Boolean(
    file &&
      file.content == null &&
      !file.error &&
      !file.truncated &&
      loadingFileId !== file.id,
  );
}

export function mergeRuntimeFileContentResult<T extends RuntimeFilePreviewEntry>(
  files: T[],
  requestedFileId: string,
  loadedFile: T | null | undefined,
  missingFileError: string,
): T[] {
  if (!loadedFile || loadedFile.id !== requestedFileId) {
    return files.map((entry) =>
      entry.id === requestedFileId ? { ...entry, error: missingFileError } : entry,
    );
  }

  return files.map((entry) =>
    entry.id === loadedFile.id ? { ...entry, ...loadedFile, error: loadedFile.error } : entry,
  );
}
