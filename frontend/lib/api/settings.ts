"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { Setting } from "./types";
import { APIError } from "./types";
import { putSettingAction } from "@/lib/actions/link";

export type { Setting };

// `settingKeys.all` is prefetched server-side in app/settings/page.tsx as the
// literal ["settings"] (this is a "use client" module) — keep in sync.
export const settingKeys = {
  all: ["settings"] as const,
  detail: (key: string) => [...settingKeys.all, key] as const,
};

export function useSettings() {
  return useQuery<Setting[]>({
    queryKey: settingKeys.all,
    queryFn: async () => {
      return apiGet<Setting[]>("/config");
    },
  });
}

export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation<Setting, Error, { key: string; value: string }>({
    mutationFn: async ({ key, value }) => {
      const r = await putSettingAction(key, { value });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data as unknown as Setting;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingKeys.all });
    },
  });
}
