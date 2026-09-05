import { useRef, useState } from "react";
import {
  PROFILE_PICTURE_MAX_BYTES,
  PROFILE_PICTURE_MAX_DIMENSION,
} from "@valet/api/wire";
import { Avatar, AvatarFallback, AvatarImage, Button } from "~/components/primitives";

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface ProfilePictureUploadProps {
  avatarUrl?: string | null;
  name: string;
  disabled?: boolean;
  pending?: boolean;
  error?: string;
  onUpload(file: File): Promise<void>;
}

/** Shared picker for user and assistant profile pictures. The API remains
 * authoritative for content validation; these checks give immediate feedback. */
export function ProfilePictureUpload({
  avatarUrl,
  name,
  disabled = false,
  pending = false,
  error,
  onUpload,
}: ProfilePictureUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string>();

  async function choose(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      setLocalError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > PROFILE_PICTURE_MAX_BYTES) {
      setLocalError("Choose an image smaller than 5 MB.");
      return;
    }
    setLocalError(undefined);
    try {
      await onUpload(file);
    } catch {
      // The mutation owns the server error and renders it through `error`.
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Avatar size="lg">
          <AvatarImage src={avatarUrl || undefined} alt="" />
          <AvatarFallback>{(name || "?").slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Profile picture file"
          disabled={disabled || pending}
          onChange={(event) => void choose(event.target.files?.[0])}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || pending}
          onClick={() => inputRef.current?.click()}
        >
          {pending ? "Uploading…" : "Upload image"}
        </Button>
      </div>
      <p className="text-xs text-muted">
        JPEG, PNG, or WebP. Maximum 5 MB and {PROFILE_PICTURE_MAX_DIMENSION} × {PROFILE_PICTURE_MAX_DIMENSION} pixels.
      </p>
      {(localError || error) && <p className="text-xs text-danger-500">{localError ?? error}</p>}
    </div>
  );
}
