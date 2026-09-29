"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Download, Plus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCreateProject } from "@/lib/api/projects";
import {
  useImportableProjects,
  useImportProject,
  useIntegrations,
} from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { formatEUR } from "@/lib/format";

const optInt = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  },
  z.number().int().positive().optional(),
);
const optPosNum = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  },
  z.number().positive().optional(),
);

const schema = z
  .object({
    name: z.string().min(1, "name is required").max(200),
    billing_model: z.enum(["time_and_material", "fixed_price"]),
    framework_id: optInt,
    agreed_amount_eur: optPosNum,
    planned_start_date: z.string().optional(),
    planned_end_date: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine(
    (v) =>
      v.billing_model !== "fixed_price" ||
      (v.agreed_amount_eur !== undefined && v.agreed_amount_eur > 0),
    { message: "Fixed-price needs agreed_amount_eur", path: ["agreed_amount_eur"] },
  );
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

type Props = {
  customerId: number;
  frameworks: { framework_id: number; name: string }[];
};

type Tab = "manual" | "import";

export function AddProjectDialog({ customerId, frameworks }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("manual");
  const integrations = useIntegrations();
  const source = integrations.data?.import_source?.projects
    ? integrations.data.import_source
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTab("manual");
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Add Project
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            T&amp;M projects can link to a framework agreement. Fixed-price
            projects need an agreed amount.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b">
          <TabButton active={tab === "manual"} onClick={() => setTab("manual")}>
            Manual
          </TabButton>
          {source && (
            <TabButton active={tab === "import"} onClick={() => setTab("import")}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Import from {source.display_name}
            </TabButton>
          )}
        </div>

        {tab === "manual" ? (
          <ManualTab
            customerId={customerId}
            frameworks={frameworks}
            onDone={() => setOpen(false)}
          />
        ) : source ? (
          <ImportTab
            source={source}
            customerId={customerId}
            frameworks={frameworks}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 border-b-2 px-3 py-1.5 text-sm",
        active
          ? "border-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ManualTab({
  customerId,
  frameworks,
  onDone,
}: {
  customerId: number;
  frameworks: { framework_id: number; name: string }[];
  onDone: () => void;
}) {
  const create = useCreateProject(customerId);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: { billing_model: "time_and_material" },
  });
  const billing_model = watch("billing_model");

  const onSubmit = handleSubmit(async (values) => {
    try {
      await create.mutateAsync({
        name: values.name,
        billing_model: values.billing_model,
        framework_id: values.framework_id || null,
        agreed_amount_eur: values.agreed_amount_eur ?? null,
        planned_start_date: values.planned_start_date || null,
        planned_end_date: values.planned_end_date || null,
        status: "active",
        notes: values.notes || null,
      });
      toast.success(`Project "${values.name}" created`);
      reset();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  return (
    <form onSubmit={onSubmit} className="contents">
      <DialogBody className="space-y-4 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" {...register("name")} autoFocus />
          {errors.name && (
            <p className="text-sm text-red-600">{errors.name.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="billing_model">Billing model</Label>
          <select
            id="billing_model"
            {...register("billing_model")}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="time_and_material">Time &amp; Material</option>
            <option value="fixed_price">Fixed Price</option>
          </select>
        </div>

        {billing_model === "time_and_material" && (
          <div className="space-y-1.5">
            <Label htmlFor="framework_id">Framework agreement (optional)</Label>
            <select
              id="framework_id"
              {...register("framework_id")}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              defaultValue=""
            >
              <option value="">— none —</option>
              {frameworks.map((f) => (
                <option key={f.framework_id} value={f.framework_id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {billing_model === "fixed_price" && (
          <div className="space-y-1.5">
            <Label htmlFor="agreed_amount_eur">Agreed amount (EUR)</Label>
            <Input
              id="agreed_amount_eur"
              type="number"
              step="0.01"
              min="0"
              {...register("agreed_amount_eur")}
            />
            {errors.agreed_amount_eur && (
              <p className="text-sm text-red-600">
                {errors.agreed_amount_eur.message}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="planned_start_date">Planned start</Label>
            <Input
              id="planned_start_date"
              type="date"
              {...register("planned_start_date")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="planned_end_date">Planned end</Label>
            <Input
              id="planned_end_date"
              type="date"
              {...register("planned_end_date")}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="notes">Notes (optional)</Label>
          <Textarea id="notes" rows={3} {...register("notes")} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onDone}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ImportTab({
  source,
  customerId,
  frameworks,
  onDone,
}: {
  source: { slug: string; display_name: string };
  customerId: number;
  frameworks: { framework_id: number; name: string }[];
  onDone: () => void;
}) {
  const list = useImportableProjects(source.slug, customerId);
  const imp = useImportProject();

  // Per-row overrides
  const [selectedFrameworkId, setSelectedFrameworkId] = useState<number | null>(
    null,
  );
  const [billingModel, setBillingModel] = useState<
    "time_and_material" | "fixed_price"
  >("time_and_material");

  async function importProject(external_id: string, name: string) {
    try {
      await imp.mutateAsync({
        integration_slug: source.slug,
        external_id,
        customer_id_override: customerId,
        framework_id_override: selectedFrameworkId,
        billing_model_override: billingModel,
      });
      toast.success(`Imported "${name}"`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="space-y-3 py-4">
      <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3 text-sm">
        <div className="space-y-1.5">
          <Label className="text-xs">Default billing model for imports</Label>
          <select
            value={billingModel}
            onChange={(e) =>
              setBillingModel(
                e.target.value as "time_and_material" | "fixed_price",
              )
            }
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            <option value="time_and_material">Time &amp; Material</option>
            <option value="fixed_price">Fixed Price</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Default framework (optional)</Label>
          <select
            value={selectedFrameworkId ?? ""}
            onChange={(e) =>
              setSelectedFrameworkId(
                e.target.value ? Number(e.target.value) : null,
              )
            }
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            <option value="">— none —</option>
            {frameworks.map((f) => (
              <option key={f.framework_id} value={f.framework_id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="max-h-[55vh] overflow-y-auto rounded-md border">
        {list.isLoading && (
          <div className="space-y-1.5 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}
        {!list.isLoading && list.data?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            No importable {source.display_name} projects for this customer.
            Either none of this customer&apos;s {source.display_name} projects
            are unmapped, or no {source.display_name} company is linked to
            this customer yet.
          </p>
        )}
        {list.data && list.data.length > 0 && (
          <ul className="divide-y text-sm">
            {list.data.slice(0, 200).map((p) => (
              <li
                key={p.external_id}
                className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{p.name}</span>
                    {p.secondary && (
                      <span className="text-xs text-muted-foreground">
                        {p.secondary}
                      </span>
                    )}
                    {p.status_name && (
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs",
                          p.status_type === "closed" &&
                            "text-muted-foreground",
                        )}
                      >
                        {p.status_name}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                    {p.start_date && <span>start {p.start_date}</span>}
                    {p.due_date && <span>due {p.due_date}</span>}
                    {p.time_budget_hours !== null &&
                      p.time_budget_hours !== undefined && (
                        <span>budget {p.time_budget_hours}h</span>
                      )}
                    {p.n_entries > 0 && (
                      <span>{p.n_entries} entries logged</span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    importProject(p.external_id, p.name ?? "")
                  }
                  disabled={imp.isPending}
                >
                  Import
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Imports pre-fill name, dates, notes (from the source description), and
        time budget. The source project gets linked automatically so tracked
        hours flow into the breakdown.
      </p>
    </div>
  );
}
