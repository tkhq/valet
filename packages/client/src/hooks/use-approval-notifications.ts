import { useEffect, useRef } from 'react';
import type { ExecutionApproval } from '@/api/executions';
import { toastWarning } from './use-toast';

/**
 * Shows a toast when new pending approvals appear.
 * Dedupes notifications via a seen set (scoped to this hook instance).
 */
export function useApprovalNotifications(approvals: ExecutionApproval[] | undefined) {
  const seenRef = useRef<Set<string>>(new Set());
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!approvals) return;

    const pending = approvals.filter((a) => a.status === 'pending');
    const newApprovals = pending.filter((a) => !seenRef.current.has(a.id));

    if (newApprovals.length > 0) {
      newApprovals.forEach((a) => seenRef.current.add(a.id));

      const message = newApprovals.length === 1
        ? `Approval required for: ${newApprovals[0].nodeId}`
        : `${newApprovals.length} approvals required`;
      toastWarning('⚠️ Action Required', message);

      // Clean up expired IDs to prevent unbounded growth
      const currentIds = new Set(pending.map((a) => a.id));
      seenRef.current.forEach((id) => {
        if (!currentIds.has(id)) seenRef.current.delete(id);
      });

      // Reset timeout to allow repeated notifications
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = setTimeout(() => {
        timeoutIdRef.current = null;
      }, 5000);
    }

    return () => {
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    };
  }, [approvals]);
}
