import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type DiscussionState = {
  changeId: number;
  ref: string;
  title: string;
  lastMessageAt: string;
  lastReadAt: string | null;
  unread: boolean;
};

export function useDiscussionStates() {
  return useQuery({
    queryKey: ["discussions.state"],
    queryFn: () => api.get<DiscussionState[]>("/discussions/state"),
    refetchInterval: 30_000,
  });
}

export function useMarkDiscussionRead(changeId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/changes/${changeId}/discussion/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discussions.state"] }),
  });
}

export function useMarkDiscussionUnread(changeId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: number) =>
      api.post<{ ok: boolean }>(`/changes/${changeId}/discussion/unread`, { commentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discussions.state"] }),
  });
}

export function useMarkAllDiscussionsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/discussions/read-all", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discussions.state"] }),
  });
}
