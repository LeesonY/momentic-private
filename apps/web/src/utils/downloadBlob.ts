/** Deliver API-fetched bytes as a local file without navigating to a URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  if (blob.size === 0) throw new Error('文件内容为空，未开始下载');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
