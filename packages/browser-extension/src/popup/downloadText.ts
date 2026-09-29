/**
 * Hands generated text to the browser as a file download.
 *
 * The popup cannot write to disk, and `chrome.downloads` would mean asking for a permission this
 * extension does not need, so the file is offered as a Blob URL on a temporary anchor — the
 * approach that works from an extension page with no extra grant.
 *
 * Kept out of the component because the part that goes wrong is the object-URL lifetime: a URL
 * revoked before the browser has read it produces a failed download with no error anywhere, and a
 * URL never revoked leaks the blob for as long as the popup lives.
 */
export function downloadTextFile(
  filename: string,
  text: string,
  mimeType = 'application/json',
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Revoked on a later task, never synchronously: the browser starts the download after the
    // click handler returns, and revoking first cancels it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
