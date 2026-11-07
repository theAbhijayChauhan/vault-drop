import JSZip from 'jszip';
import { VaultFile, FileCategory, VaultUsage } from './types';
import { supabase, isSupabaseConfigured, supabaseUrl, supabaseAnonKey } from './supabase';
import { isMockMode } from './auth-helpers';

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB (20,971,520 bytes)
export const MAX_USER_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB
const MOCK_STORAGE_FILES_PREFIX = 'vaultdrop_files_';
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Categorize MIME types and file extensions into 6 UI filter buckets.
 */
export function getFileCategory(filename: string, mimeType: string): FileCategory {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
    return 'image';
  }
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return 'pdf';
  }
  if (
    ['doc', 'docx', 'txt', 'rtf', 'md', 'csv', 'xlsx', 'xls', 'pptx'].includes(ext) ||
    mimeType.includes('word') ||
    mimeType.includes('document') ||
    mimeType.includes('sheet')
  ) {
    return 'doc';
  }
  if (
    ['js', 'ts', 'jsx', 'tsx', 'py', 'c', 'cpp', 'java', 'html', 'css', 'json', 'sql', 'sh', 'rs', 'go'].includes(ext)
  ) {
    return 'code';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || mimeType.includes('zip') || mimeType.includes('compressed')) {
    return 'archive';
  }
  return 'other';
}

/**
 * Format bytes to human-readable string. Guarded against negative/NaN input.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Get human remaining time formatted like 'expires in 18h 42m' or 'expires in 04m 12s'.
 */
export function getExpiryLabel(expiresAt: string): { label: string; isUrgent: boolean } {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) {
    return { label: 'Expired', isUrgent: true };
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  const isUrgent = hours === 0; // Under 1 hour remaining

  if (hours > 0) {
    return {
      label: `expires in ${hours}h ${minutes}m`,
      isUrgent,
    };
  }

  return {
    label: `expires in ${minutes}m ${seconds}s`,
    isUrgent: true,
  };
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Extract a safe, conservative file extension (letters/digits only, <= 10 chars). */
function safeExtension(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext.slice(0, 10);
}

/**
 * Storage keys are `user_<ownerId>/<fileId>.<ext>` — the raw filename NEVER
 * enters the path (no traversal, no unicode tricks, no mismatch on rebuild),
 * and the schema CHECK constraint guarantees the path stays in the owner folder.
 */
function buildStoragePath(userId: string, fileId: string, filename: string): string {
  const ext = safeExtension(filename);
  return ext ? `user_${userId}/${fileId}.${ext}` : `user_${userId}/${fileId}`;
}

/**
 * Upload to Supabase Storage with REAL byte-accurate progress via XHR
 * (the SDK's upload() has no progress callback). Falls back to SDK upload
 * if the session token can't be obtained.
 */
async function uploadWithProgress(
  storagePath: string,
  file: File,
  accessToken: string,
  onByteProgress?: (fraction: number) => void
): Promise<{ ok: boolean; error?: string }> {
  // Read file data into memory first to avoid mobile WebKit file descriptor streaming resets
  let payload: BodyInit = file;
  try {
    payload = await file.arrayBuffer();
  } catch {
    payload = file;
  }

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    // Encode each path segment individually — keep the `/` separators intact.
    const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
    xhr.open('POST', `${supabaseUrl}/storage/v1/object/vault/${encodedPath}`);
    xhr.setRequestHeader('apikey', supabaseAnonKey);
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('cache-control', '3600');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onByteProgress?.(e.loaded / e.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
      } else {
        try {
          const body = JSON.parse(xhr.responseText);
          resolve({ ok: false, error: body.message || body.error || `Upload failed (HTTP ${xhr.status})` });
        } catch {
          resolve({ ok: false, error: `Upload failed (HTTP ${xhr.status})` });
        }
      }
    };

    xhr.onerror = () => resolve({ ok: false, error: 'Network error during upload.' });
    xhr.onabort = () => resolve({ ok: false, error: 'Upload cancelled.' });

    try {
      xhr.send(payload);
    } catch {
      resolve({ ok: false, error: 'Network error during upload.' });
    }
  });
}

/** Map overall upload pipeline progress: 15% start → 85% bytes → 90% DB → 100% signed URL. */
function pipelineProgress(stage: 'start' | number | 'db' | 'done', onProgress?: (p: number) => void) {
  if (!onProgress) return;
  if (stage === 'start') onProgress(15);
  else if (stage === 'db') onProgress(90);
  else if (stage === 'done') onProgress(100);
  else onProgress(15 + Math.round(Math.min(Math.max(stage, 0), 1) * 70));
}

/**
 * Upload a file to user's ephemeral vault.
 * Client checks are UX only — the Postgres quota trigger is the real enforcement.
 */
export async function uploadVaultFile(
  userId: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<{ success: boolean; file?: VaultFile; error?: string }> {
  // 1. Client-side sanity checks matching schema
  if (file.name.length < 1 || file.name.length > 255) {
    return { success: false, error: 'Filename length must be between 1 and 255 characters.' };
  }

  if (file.size <= 0) {
    return { success: false, error: 'Cannot upload empty file.' };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { success: false, error: 'File exceeds 20 MB size limit.' };
  }

  const mimeType = (file.type || 'application/octet-stream').substring(0, 100);
  const category = getFileCategory(file.name, mimeType);

  // Supabase Cloud Environment
  if (isSupabaseConfigured && supabase) {
    // 2. Server-truth quota pre-check (the trigger remains the enforcement)
    const usage = await getVaultUsage();
    if (usage && usage.usedBytes + file.size > usage.capBytes) {
      return { success: false, error: 'Storage cap exceeded. Delete old files to free up space.' };
    }

    pipelineProgress('start', onProgress);

    const fileId = generateUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
    const storagePath = buildStoragePath(userId, fileId, file.name);

    // 3. Upload bytes with real byte progress
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;

    let uploadResult: { ok: boolean; error?: string };
    if (accessToken) {
      uploadResult = await uploadWithProgress(storagePath, file, accessToken, (fraction) =>
        pipelineProgress(fraction, onProgress)
      );

      // Multi-layer fallback for mobile network resiliency:
      // If direct XHR upload dropped due to mobile browser sandboxing or network abort,
      // seamlessly retry via Supabase's native SDK upload (fetch + FormData)
      if (!uploadResult.ok) {
        console.warn('XHR upload dropped, retrying with Supabase SDK upload:', uploadResult.error);
        const { error: sdkError } = await supabase.storage
          .from('vault')
          .upload(storagePath, file, { cacheControl: '3600', upsert: false });
        uploadResult = sdkError ? { ok: false, error: sdkError.message } : { ok: true };
        if (uploadResult.ok) pipelineProgress(1, onProgress);
      }
    } else {
      const { error: sdkError } = await supabase.storage
        .from('vault')
        .upload(storagePath, file, { cacheControl: '3600', upsert: false });
      uploadResult = sdkError ? { ok: false, error: sdkError.message } : { ok: true };
      if (uploadResult.ok) pipelineProgress(1, onProgress);
    }

    if (!uploadResult.ok) {
      return { success: false, error: uploadResult.error || 'Upload failed.' };
    }

    pipelineProgress('db', onProgress);

    // 4. Register metadata (enforce_storage_quota_trigger runs here)
    const { error: dbError } = await supabase.from('files').insert({
      id: fileId,
      owner_id: userId,
      filename: file.name,
      storage_path: storagePath,
      size_bytes: file.size,
      mime_type: mimeType,
      expires_at: expiresAt,
    });

    if (dbError) {
      // Rollback the storage object if the database rejected the row
      await supabase.storage.from('vault').remove([storagePath]).catch(() => {});
      const message = dbError.message || '';
      if (dbError.code === 'P0001' || message.toLowerCase().includes('quota')) {
        return { success: false, error: 'Storage quota exceeded. Please delete old files to free up space.' };
      }
      if (dbError.code === '23505' || message.toLowerCase().includes('duplicate')) {
        return { success: false, error: 'This file is already in your vault. Try again.' };
      }
      return { success: false, error: 'Upload could not be registered. Please try again.' };
    }

    // 5. Short-lived signed URL so preview/download work immediately
    const { data: signedUrlData } = await supabase.storage.from('vault').createSignedUrl(storagePath, 60);

    pipelineProgress('done', onProgress);

    const uploadedFile: VaultFile = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: mimeType,
      category,
      uploadedAt: new Date().toISOString(),
      expiresAt,
      storagePath,
      url: signedUrlData?.signedUrl,
      urlExpiresAt: Date.now() + 55 * 1000,
      blob: file,
    };

    return { success: true, file: uploadedFile };
  }

  // Local development mock
  if (isMockMode && typeof window !== 'undefined') {
    onProgress?.(30);
    const existingFiles = await getUserFiles(userId).catch(() => [] as VaultFile[]);
    const currentTotal = existingFiles.reduce((acc, f) => acc + f.size, 0);
    if (currentTotal + file.size > MAX_USER_STORAGE_BYTES) {
      return { success: false, error: 'Storage cap exceeded. Total vault usage cannot exceed 50 MB.' };
    }

    onProgress?.(60);
    let content: string | undefined;
    if (
      file.type.startsWith('text/') ||
      ['json', 'js', 'ts', 'py', 'c', 'cpp', 'html', 'css', 'md'].includes(file.name.split('.').pop() || '')
    ) {
      try {
        content = await file.text();
      } catch {
        // ignore
      }
    }

    onProgress?.(85);
    const fileId = generateUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const newFile: VaultFile = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: mimeType,
      category,
      uploadedAt: new Date().toISOString(),
      expiresAt,
      url: URL.createObjectURL(file),
      content,
      blob: file,
    };

    const updatedFiles = [newFile, ...existingFiles.map((f) => ({ ...f, blob: undefined }))];
    localStorage.setItem(
      `${MOCK_STORAGE_FILES_PREFIX}${userId}`,
      JSON.stringify(updatedFiles.map((f) => ({ ...f, blob: undefined })))
    );

    onProgress?.(100);
    return { success: true, file: newFile };
  }

  return { success: false, error: 'VaultDrop is not configured.' };
}

/**
 * Server-truth vault usage (get_vault_usage RPC). Returns null when offline —
 * callers should keep their last known value rather than resetting to 0.
 */
export async function getVaultUsage(): Promise<VaultUsage | null> {
  if (!(isSupabaseConfigured && supabase)) return null;
  try {
    const { data, error } = await supabase.rpc('get_vault_usage');
    if (error || !data) return null;
    return { usedBytes: Number(data.usedBytes ?? 0), capBytes: Number(data.capBytes ?? MAX_USER_STORAGE_BYTES) };
  } catch {
    return null;
  }
}

/**
 * Fetch all live files for a user. THROWS on transport errors so callers can
 * keep their previous list — a transient network blip must never look like an
 * empty vault. Fresh signed URLs are batch-generated; entries still fresh from
 * a previous fetch are reused to keep the 8-second heartbeat cheap.
 */
export async function getUserFiles(
  userId: string,
  previous?: VaultFile[]
): Promise<VaultFile[]> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('files')
      .select('id, filename, storage_path, size_bytes, mime_type, created_at, expires_at')
      .eq('owner_id', userId)
      .order('expires_at', { ascending: false });

    if (error) throw new Error(error.message || 'Failed to load vault files.');
    if (!data) return [];

    const now = Date.now();
    const valid = data.filter((row) => new Date(row.expires_at).getTime() > now);
    if (valid.length === 0) return [];

    // Reuse URLs that are still comfortably fresh (>90s remaining)
    const freshUrls = new Map<string, { url: string; urlExpiresAt: number }>();
    previous?.forEach((f) => {
      if (f.storagePath && f.url && f.urlExpiresAt && f.urlExpiresAt > now + 90 * 1000) {
        freshUrls.set(f.storagePath, { url: f.url, urlExpiresAt: f.urlExpiresAt });
      }
    });

    const stalePaths = valid
      .map((row) => row.storage_path as string)
      .filter((path) => !freshUrls.has(path));

    if (stalePaths.length > 0) {
      try {
        const { data: signedUrls, error: urlError } = await supabase.storage
          .from('vault')
          .createSignedUrls(stalePaths, SIGNED_URL_TTL_SECONDS);
        if (!urlError && signedUrls) {
          signedUrls.forEach((item) => {
            if (item?.signedUrl && item?.path) {
              freshUrls.set(item.path, {
                url: item.signedUrl,
                urlExpiresAt: now + (SIGNED_URL_TTL_SECONDS - 60) * 1000,
              });
            }
          });
        }
      } catch {
        // Signed URLs are a convenience; rows still render without them.
      }
    }

    return valid.map((row) => {
      const fresh = freshUrls.get(row.storage_path);
      return {
        id: row.id,
        name: row.filename,
        size: Number(row.size_bytes),
        type: row.mime_type,
        category: getFileCategory(row.filename, row.mime_type),
        uploadedAt: row.created_at,
        expiresAt: row.expires_at,
        storagePath: row.storage_path,
        url: fresh?.url,
        urlExpiresAt: fresh?.urlExpiresAt,
      };
    });
  }

  if (isMockMode && typeof window !== 'undefined') {
    const raw = localStorage.getItem(`${MOCK_STORAGE_FILES_PREFIX}${userId}`);
    if (!raw) return [];
    try {
      const files: VaultFile[] = JSON.parse(raw);
      const now = Date.now();
      return files.filter((f) => new Date(f.expiresAt).getTime() > now);
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Delete a specific file — VERIFIED. Supabase blocks SQL-level blob deletes,
 * so the blob is removed through the Storage API FIRST, then the database row
 * (which also fires the best-effort cleanup trigger). Returns true only when
 * the database row was actually deleted.
 */
export async function deleteVaultFile(userId: string, fileId: string): Promise<boolean> {
  if (isSupabaseConfigured && supabase) {
    // 1. Remove the blob via the Storage API (path comes from the row itself)
    let storagePath: string | undefined;
    try {
      const { data: row } = await supabase
        .from('files')
        .select('storage_path')
        .eq('id', fileId)
        .eq('owner_id', userId)
        .maybeSingle();
      storagePath = row?.storage_path;
    } catch {
      // fall through — row delete will still verify ownership
    }

    if (storagePath) {
      try {
        await supabase.storage.from('vault').remove([storagePath]);
      } catch {
        // Blob removal is best-effort; the row delete below is the source of truth.
      }
    }

    // 2. Delete the database row (verified via returning)
    const { data, error } = await supabase
      .from('files')
      .delete({ count: 'exact' })
      .eq('id', fileId)
      .eq('owner_id', userId)
      .select('id');

    return !error && Array.isArray(data) && data.length > 0;
  }

  if (isMockMode && typeof window !== 'undefined') {
    const files = await getUserFiles(userId).catch(() => [] as VaultFile[]);
    const filtered = files.filter((f) => f.id !== fileId);
    localStorage.setItem(`${MOCK_STORAGE_FILES_PREFIX}${userId}`, JSON.stringify(filtered));
    return true;
  }

  return false;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.style.display = 'none';
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    if (document.body.contains(link)) document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  }, 2000);
}

/** Download the binary payload for a file from Storage (never rebuild the path). */
async function fetchFileBlob(file: VaultFile): Promise<Blob | null> {
  if (file.blob) return file.blob;

  if (isSupabaseConfigured && supabase && file.storagePath) {
    try {
      const { data, error } = await supabase.storage.from('vault').download(file.storagePath);
      if (!error && data) return data;
    } catch {
      // fall through to signed URL
    }
  }

  if (file.url) {
    try {
      const response = await fetch(file.url);
      if (response.ok) return await response.blob();
    } catch {
      // fall through
    }
  }

  if (file.content) {
    return new Blob([file.content], { type: file.type || 'text/plain' });
  }

  return null;
}

/**
 * Direct file download guaranteed to work reliably on both PC and mobile
 * smartphones: fetch bytes → same-origin blob: URL → programmatic anchor click.
 * Returns false ONLY when nothing could be downloaded (no silent fake success).
 */
export async function downloadVaultFileDirectly(file: VaultFile): Promise<boolean> {
  try {
    const blob = await fetchFileBlob(file);
    if (!blob) return false;
    triggerBlobDownload(blob, file.name);
    return true;
  } catch (err) {
    console.error('downloadVaultFileDirectly failed:', err);
    return false;
  }
}

/**
 * Bulk zip download of selected files using JSZip.
 * Downloads in PARALLEL; returns the names of files that could not be fetched
 * so the UI can warn about an incomplete archive. Throws only if everything
 * failed or zip generation fails.
 */
export async function downloadFilesAsZip(
  files: VaultFile[],
  zipName = 'vaultdrop_bundle.zip'
): Promise<{ failed: string[] }> {
  const zip = new JSZip();

  const results = await Promise.allSettled(files.map((file) => fetchFileBlob(file)));

  const failed: string[] = [];
  const used = new Set<string>();
  let added = 0;

  results.forEach((result, index) => {
    const file = files[index];
    if (result.status === 'fulfilled' && result.value) {
      // Defend against duplicate names inside the archive
      let name = file.name;
      let n = 2;
      while (used.has(name)) {
        const dot = file.name.lastIndexOf('.');
        name = dot > 0 ? `${file.name.slice(0, dot)} (${n})${file.name.slice(dot)}` : `${file.name} (${n})`;
        n += 1;
      }
      used.add(name);
      zip.file(name, result.value);
      added += 1;
    } else {
      failed.push(file.name);
    }
  });

  if (added === 0) {
    throw new Error('None of the selected files could be downloaded.');
  }

  const content = await zip.generateAsync({ type: 'blob' });
  triggerBlobDownload(content, zipName);

  return { failed };
}
