import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { ImageCatalogEntryWire } from "@valet/api/wire";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input, Label, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import {
  useCreateImageCatalogEntry,
  useDeleteImageCatalogEntry,
  useImageCatalog,
} from "~/api/settings";

/**
 * Organization · Sandbox images — the base-image catalog (sandbox images
 * v2 plan, Task 6). Admin-registered images a prebuild config can pin to
 * instead of the stock sandbox image. Usable independent of whether a
 * builder is wired for this deployment — the catalog is just data; only
 * `PrebuildsSection`'s rebuild action needs a real builder.
 */
export function ImageCatalogSection() {
  const catalogQ = useImageCatalog();
  const images = catalogQ.data?.images ?? [];

  return (
    <Section
      title="Base image catalog"
      description="Base images a prebuild config can pin to instead of the stock sandbox image. Must include git — the prebuild recipe clones the repo as its first step."
    >
      {catalogQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {catalogQ.error && <p className="py-4 text-sm text-danger-500">Failed to load the image catalog.</p>}

      {catalogQ.data && (
        <div className="divide-y divide-line">
          {images.map((image) => (
            <ImageCatalogRow key={image.id} image={image} />
          ))}
          <CreateImageCatalogRow />
        </div>
      )}
    </Section>
  );
}

function ImageCatalogRow({ image }: { image: ImageCatalogEntryWire }) {
  const deleteEntry = useDeleteImageCatalogEntry();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{image.name}</span>
          {image.pullSecretName && <Badge variant="neutral">{image.pullSecretName}</Badge>}
        </div>
        <span className="block truncate text-xs text-muted">{image.ref}</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Delete ${image.name}`}
        onClick={() => setConfirmDelete(true)}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={`Delete ${image.name}?`}
          description="Prebuild configs pinned to this image keep their last built image, but future rebuilds will fail until repointed."
        >
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={deleteEntry.isPending}
              onClick={() => deleteEntry.mutate(image.id, { onSuccess: () => setConfirmDelete(false) })}
            >
              {deleteEntry.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateImageCatalogRow() {
  const createEntry = useCreateImageCatalogEntry();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [pullSecretName, setPullSecretName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!name.trim() || !ref.trim()) return;
    setError(null);
    createEntry.mutate(
      { name: name.trim(), ref: ref.trim(), pullSecretName: pullSecretName.trim() || undefined },
      {
        onSuccess: () => {
          setName("");
          setRef("");
          setPullSecretName("");
          setOpen(false);
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  if (!open) {
    return (
      <div className="py-4">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Add base image
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-4">
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="new-image-name">Name</Label>
          <Input id="new-image-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Node 22" />
        </div>
        <div className="flex-1 space-y-1">
          <Label htmlFor="new-image-ref">Image ref</Label>
          <Input
            id="new-image-ref"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="registry.example.com/valet-base:node22"
          />
        </div>
        <div className="flex-1 space-y-1">
          <Label htmlFor="new-image-pull-secret">Pull secret name (optional)</Label>
          <Input
            id="new-image-pull-secret"
            value={pullSecretName}
            onChange={(e) => setPullSecretName(e.target.value)}
            placeholder="regcred"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={submit}
          disabled={!name.trim() || !ref.trim() || createEntry.isPending}
        >
          {createEntry.isPending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}
