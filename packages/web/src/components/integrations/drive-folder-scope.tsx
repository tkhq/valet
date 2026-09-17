/**
 * Personal Integrations → choose which Drive folders Valet may use.
 *
 * Without a scope the assistant reaches as far as the OAuth grant does,
 * which is the whole of the person's Drive. The scope narrows that to a set
 * of folders and everything under them. It is enforced in the
 * google-workspace plugin, not here: this screen only reads and writes the
 * list. See `docs/specs/2026-09-17-drive-folder-scope-design.md`.
 *
 * Two states that look alike and are not: no scope allows everything, and a
 * scope holding no folders allows nothing. So "Allow all of Drive" clears
 * the scope rather than saving an empty list, and the screen never presents
 * an empty selection as if it were unrestricted.
 */
import { useEffect, useState } from "react";
import {
  useDriveFolderScope,
  useDriveFolders,
  useSetDriveFolderScope,
} from "~/api/integrations";
import { Button, Popover, PopoverContent, PopoverTrigger } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

interface Crumb {
  id: string;
  name: string;
}

const ROOT: Crumb = { id: "root", name: "My Drive" };

export function DriveFolderScope({ service, title }: { service: string; title: string }) {
  const [open, setOpen] = useState(false);
  const scopeQ = useDriveFolderScope(service, { enabled: open });
  const save = useSetDriveFolderScope(service);

  const [trail, setTrail] = useState<Crumb[]>([ROOT]);
  const here = trail[trail.length - 1] ?? ROOT;
  const foldersQ = useDriveFolders(service, here.id, { enabled: open });

  // The saved scope is the starting selection. It arrives after the popover
  // opens, so it syncs on the prop rather than only seeding at mount.
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const saved = scopeQ.data?.folderIds ?? null;
  useEffect(() => {
    if (touched) return;
    setSelected(saved ?? []);
  }, [saved, touched]);

  function reset() {
    setTrail([ROOT]);
    setTouched(false);
    setSelected([]);
    save.reset();
  }

  function toggle(id: string) {
    setTouched(true);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const folders = foldersQ.data?.folders ?? [];
  const restricted = saved !== null;
  const summary = !restricted
    ? "All of your Drive"
    : saved.length === 0
      ? "No folders — nothing is readable"
      : `${saved.length} folder${saved.length === 1 ? "" : "s"}`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Choose which Drive folders ${title} may use`}>
          Folders
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-2 pb-2 text-xs text-muted">
          Pick the folders Valet may use. It reaches each folder you pick and everything inside
          it, and nothing else in your Drive. Pick none and Valet uses all of your Drive.
        </p>
        <p className="px-2 pb-2 text-xs">
          <span className="text-muted">Now:</span>{" "}
          <span className={restricted && saved.length === 0 ? "text-danger-500" : undefined}>
            {scopeQ.isLoading ? "Loading…" : summary}
          </span>
        </p>

        {/* Breadcrumb. Each crumb walks back up the tree it descended. */}
        <nav className="flex flex-wrap items-center gap-1 px-2 pb-1 text-xs" aria-label="Folder path">
          {trail.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted">/</span>}
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => setTrail(trail.slice(0, i + 1))}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        {foldersQ.isLoading && <p className="px-2 py-2 text-xs text-muted">Loading folders…</p>}
        {foldersQ.error && (
          <p className="px-2 py-2 text-xs text-danger-500">{errorText(foldersQ.error)}</p>
        )}
        {!foldersQ.isLoading && !foldersQ.error && folders.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted">No subfolders here.</p>
        )}

        <ul className="max-h-60 space-y-1 overflow-y-auto">
          {folders.map((folder) => (
            <li key={folder.id} className="flex items-center gap-2 px-2 text-xs">
              <input
                type="checkbox"
                id={`scope-${folder.id}`}
                checked={selected.includes(folder.id)}
                onChange={() => toggle(folder.id)}
              />
              <label htmlFor={`scope-${folder.id}`} className="flex-1 truncate">
                {folder.name}
              </label>
              <button
                type="button"
                className="text-muted underline-offset-2 hover:underline"
                onClick={() => setTrail([...trail, { id: folder.id, name: folder.name }])}
                aria-label={`Open ${folder.name}`}
              >
                Open
              </button>
            </li>
          ))}
        </ul>

        {selected.length > 0 && (
          <p className="px-2 pt-2 text-xs text-muted">
            {selected.length} selected. Selections from other folders are kept.
          </p>
        )}
        {save.error && (
          <p className="px-2 pt-2 text-xs text-danger-500">{errorText(save.error)}</p>
        )}

        <div className="flex items-center justify-between gap-2 px-2 pt-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={save.isPending || !restricted}
            onClick={() => save.mutate(null, { onSuccess: () => setTouched(false) })}
          >
            Allow all of Drive
          </Button>
          <Button
            size="sm"
            disabled={save.isPending || selected.length === 0}
            onClick={() => save.mutate(selected, { onSuccess: () => setTouched(false) })}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
