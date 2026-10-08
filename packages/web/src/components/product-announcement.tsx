import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { ProductAnnouncementsResponse } from "@valet/api/wire";
import { api } from "~/api/client";
import { useMe } from "~/api/settings";
import { Button } from "~/components/primitives/button";

/** A nonmodal release notice. A successful dismissal or CTA saves acknowledgement. */
export function ProductAnnouncement() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const activeUser = useRef(me?.id);
  activeUser.current = me?.id;
  useEffect(() => {
    activeUser.current = me?.id;
    return () => { activeUser.current = undefined; };
  }, [me?.id]);
  const client = useQueryClient();
  const queryKey = ["product-announcements", me?.id];
  const { data } = useQuery({ queryKey, queryFn: api.productAnnouncements, enabled: !!me?.id });
  const notice = data?.announcements[0];
  const acknowledge = useMutation({
    mutationFn: ({ id }: { id: string; userId: string; href?: string }) => api.acknowledgeProductAnnouncement(id),
    onSuccess: (_, { id, userId, href }) => {
      if (activeUser.current !== userId) return;
      client.setQueryData<ProductAnnouncementsResponse>(queryKey, previous => ({
        announcements: previous?.announcements.filter(item => item.id !== id) ?? [],
      }));
      if (href) void navigate({ to: href });
    },
  });
  if (!me || !notice) return null;
  return <section aria-label="Product update" className="fixed bottom-4 left-4 right-4 z-40 rounded-lg border border-line bg-paper p-4 shadow-lg sm:left-auto sm:w-96">
    <div className="flex items-start gap-3">
      <h2 className="flex-1 text-sm font-semibold text-ink">{notice.title}</h2>
      <Button variant="ghost" size="icon" aria-label="Dismiss product update" disabled={acknowledge.isPending}
        onClick={() => acknowledge.mutate({ id: notice.id, userId: me.id })}><X size={16} /></Button>
    </div>
    <p className="mt-2 text-sm text-muted">{notice.body}</p>
    {acknowledge.isError && <p role="alert" className="mt-2 text-sm text-danger-500">Could not save your dismissal. Try again.</p>}
    <Button className="mt-3" size="sm" disabled={acknowledge.isPending}
      onClick={() => acknowledge.mutate({ id: notice.id, userId: me.id, href: notice.action.href })}>{notice.action.label}</Button>
  </section>;
}
