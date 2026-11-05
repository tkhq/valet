import { useState } from "react";
import { Download, Maximize2 } from "lucide-react";
import { Dialog, DialogContent } from "~/components/primitives";

/**
 * An image the assistant produced, inline in the thread. The thumbnail fits
 * the message column (a phone's 375px width included) and opens a lightbox
 * at full size. The download link keeps the original bytes and name.
 */
export function ImagePreview({ src, alt, title, download }: {
  src: string;
  alt: string;
  title?: string;
  /** The original file, when it can be downloaded. */
  download?: { href: string; name: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="min-w-0 max-w-full space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${title ?? alt} full size`}
        className="group relative block max-w-full overflow-hidden rounded border border-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40"
      >
        <img src={src} alt={alt} loading="lazy" className="block h-auto max-h-96 w-auto max-w-full object-contain" />
        <span aria-hidden className="absolute right-1.5 top-1.5 rounded bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Maximize2 className="h-3.5 w-3.5" />
        </span>
      </button>
      {(title || download) && (
        <figcaption className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {title && <span className="min-w-0 break-words">{title}</span>}
          {download && <DownloadLink {...download} />}
        </figcaption>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={title ?? alt} className="max-w-[min(96vw,1400px)] p-3 sm:p-4">
          <img src={src} alt={alt} className="mx-auto block h-auto max-h-[calc(100dvh-9rem)] w-auto max-w-full bg-white object-contain" />
          {download && <div className="flex justify-end"><DownloadLink {...download} /></div>}
        </DialogContent>
      </Dialog>
    </figure>
  );
}

function DownloadLink({ href, name }: { href: string; name: string }) {
  return (
    <a href={href} download={name} className="inline-flex min-h-11 items-center gap-1.5 text-moss hover:underline sm:min-h-0">
      <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-all">Download {name}</span>
    </a>
  );
}
