/**
 * Default per-file cap for sandbox file uploads, in bytes (50 MB).
 *
 * One definition for every surface: the api route reads it as the default
 * for VALET_MAX_UPLOAD_BYTES, and the web composer uses it for client-side
 * rejection. An operator who overrides VALET_MAX_UPLOAD_BYTES changes only
 * the server cap — the composer still pre-rejects above this default, and
 * the server's 413 (with its corrective) governs everything else.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
