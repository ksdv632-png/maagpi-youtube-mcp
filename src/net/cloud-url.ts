/**
 * Turn "share" links from common cloud-storage services into direct-download URLs.
 * Anything not recognised is returned unchanged (S3/R2/GCS pre-signed URLs, plain https links…).
 *
 * Not supported (no stable direct-download URL exists): iCloud Drive/Photos links and
 * OneDrive/SharePoint "page" links — use a direct link or one of the supported services.
 */

const DROPBOX_HOSTS = new Set(["www.dropbox.com", "dropbox.com"]);
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);

export class CloudUrlError extends Error {}

export function normalizeCloudUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CloudUrlError("sourceUrl is not a valid URL");
  }
  const host = url.hostname.toLowerCase();

  if (DROPBOX_HOSTS.has(host)) {
    url.searchParams.delete("raw");
    url.searchParams.set("dl", "1");
    return url.toString();
  }

  if (DRIVE_HOSTS.has(host)) {
    if (/^\/drive\/folders\//.test(url.pathname) || /\/folders\//.test(url.pathname)) {
      throw new CloudUrlError("This is a Google Drive folder link. Share a single video file instead.");
    }
    const fromPath = /\/(?:file\/d|document\/d|presentation\/d|spreadsheets\/d)\/([\w-]{10,})/.exec(url.pathname);
    const id = fromPath?.[1] ?? url.searchParams.get("id");
    if (!id || !/^[\w-]{10,}$/.test(id)) {
      throw new CloudUrlError("Could not find the file id in this Google Drive link.");
    }
    const direct = new URL("https://drive.usercontent.google.com/download");
    direct.searchParams.set("id", id);
    direct.searchParams.set("export", "download");
    direct.searchParams.set("confirm", "t");
    return direct.toString();
  }

  if (host === "www.icloud.com" || host === "icloud.com" || host.endsWith(".icloud.com")) {
    throw new CloudUrlError(
      "iCloud links cannot be downloaded directly. Upload the file to Google Drive or Dropbox and share an 'anyone with the link' URL."
    );
  }

  return url.toString();
}
