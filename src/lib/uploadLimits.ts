export const MAX_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_BATCH_BYTES = 40 * 1024 * 1024;

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export function validateImageUploadFiles(files: File[]): string | null {
  const tooLarge = files.find((file) => file.size > MAX_IMAGE_FILE_SIZE_BYTES);
  if (tooLarge) {
    return `"${tooLarge.name}" quá nặng (${formatFileSize(tooLarge.size)}). Mỗi ảnh tối đa ${formatFileSize(MAX_IMAGE_FILE_SIZE_BYTES)}.`;
  }

  const batchSize = files.reduce((sum, file) => sum + file.size, 0);
  if (batchSize > MAX_IMAGE_UPLOAD_BATCH_BYTES) {
    return `Một lần upload tối đa ${formatFileSize(MAX_IMAGE_UPLOAD_BATCH_BYTES)}. Lần này đang là ${formatFileSize(batchSize)}.`;
  }

  return null;
}
