"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useIntegrations } from "@/lib/api/integrations";
import type { LinkInput } from "@/lib/actions/external-links";

import { ExternalLinkCard } from "./external-link-card";

/** One link card per enabled integration that can be linked to this kind
 * of Dante entity: projects get a card per integration providing
 * `projects`; employees per integration providing
 * `external_contributors` (the HRIS person link is owned by the sync and
 * not shown); customers per integration providing `companies`. */
export function EntityLinkCards({ danteType, danteId }: { danteType: LinkInput["dante_type"]; danteId: number }) {
  const q = useIntegrations();
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  const capability =
    danteType === "project" ? "projects" : danteType === "customer" ? "companies" : "external_contributors";
  const entityType: LinkInput["entity_type"] =
    danteType === "project" ? "project" : danteType === "customer" ? "company" : "person";
  const list = (q.data?.integrations ?? []).filter((i) => i.capabilities.includes(capability));
  if (list.length === 0) return null;
  return (
    <>
      {list.map((i) => (
        <ExternalLinkCard
          key={i.slug}
          integration={i}
          entityType={entityType}
          danteType={danteType}
          danteId={danteId}
          hint={
            danteType === "employee"
              ? `No ${i.display_name} user mapped. Auto-mapping by e-mail happens during sync — this is for fixing mismatches.`
              : danteType === "project"
                ? `No ${i.display_name} project linked yet. Tracked time on this project stays empty until at least one is mapped here.`
                : undefined
          }
        />
      ))}
    </>
  );
}
