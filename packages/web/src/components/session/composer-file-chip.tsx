import { RotateCw, Trash2, AlertCircle, Loader } from "lucide-react";
import { Button } from "~/components/primitives";
import { formatSize, isFileUploading, type ComposerFile } from "./composer-files";

interface FileChipProps {
  file: ComposerFile;
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}

/**
 * Display one file chip: filename, size, and status. Shows a spinner while
 * the upload is in flight (fetch exposes no upload progress, so there is no
 * percentage bar), a checkmark when done, error icon + retry on failure.
 */
export function FileChip({ file, onRemove, onRetry }: FileChipProps) {
  const isUploading = isFileUploading(file);
  const isSuccess = file.attachmentRef !== undefined;
  const isError = file.error !== undefined;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-[--bg-secondary] rounded-lg border border-[--border] text-sm">
      {isUploading && <Loader className="h-4 w-4 text-muted animate-spin" />}
      {isSuccess && <span className="text-success-600">✓</span>}
      {isError && <AlertCircle className="h-4 w-4 text-danger-600" />}

      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{file.name}</div>
        {isError && <div className="text-danger-600 text-xs mt-0.5">{file.error}</div>}
        {!isError && (
          <div className="text-muted text-xs">
            {formatSize(file.bytes)}
            {isUploading ? " · uploading…" : ""}
          </div>
        )}
      </div>

      {isError && onRetry && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRetry(file.id)}
          title="Retry upload"
          aria-label="Retry upload"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      )}

      {(isSuccess || isError) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRemove(file.id)}
          title="Remove file"
          aria-label="Remove file"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
