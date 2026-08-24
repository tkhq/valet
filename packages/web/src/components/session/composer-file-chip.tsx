import { RotateCw, Trash2, AlertCircle, Loader } from "lucide-react";
import { Button } from "~/components/primitives";
import { formatSize, type ComposerFile } from "./composer-files";

interface FileChipProps {
  file: ComposerFile;
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}

/**
 * Display one file chip: filename, size, progress/status, and remove button.
 * Shows spinner during upload, success checkmark when done, error icon + retry
 * button on failure.
 */
export function FileChip({ file, onRemove, onRetry }: FileChipProps) {
  const isUploading = file.uploadProgress !== null && !file.attachmentRef && !file.error;
  const isSuccess = file.attachmentRef !== undefined;
  const isError = file.error !== undefined;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-[--bg-secondary] rounded-lg border border-[--border] text-sm">
      {isUploading && <Loader className="h-4 w-4 text-muted animate-spin" />}
      {isSuccess && <span className="text-success-600">✓</span>}
      {isError && <AlertCircle className="h-4 w-4 text-danger-600" />}

      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{file.name}</div>
        {isUploading && (
          <div className="mt-1 h-1.5 w-full bg-[--border] rounded-full overflow-hidden">
            <div
              className="h-full bg-moss transition-all duration-300"
              style={{ width: `${file.uploadProgress}%` }}
            />
          </div>
        )}
        {isError && <div className="text-danger-600 text-xs mt-0.5">{file.error}</div>}
        {!isError && <div className="text-muted text-xs">{formatSize(file.bytes)}</div>}
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
