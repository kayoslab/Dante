"use client";

import { useMemo, useState } from "react";
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
import { useCreateCustomer } from "@/lib/api/customers";
import {
  useAworkCompanies,
  useImportCustomerFromAwork,
} from "@/lib/api/awork";
import { cn } from "@/lib/utils";

const schema = z.object({
  name: z.string().min(1, "name is required").max(200),
  notes: z.string().max(2000).optional(),
});
type FormValues = z.infer<typeof schema>;

type Tab = "manual" | "awork";

export function AddCustomerDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("manual");

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
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Add Customer
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Customer</DialogTitle>
          <DialogDescription>
            Create a fresh customer or import an awork company directly.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b">
          <TabButton active={tab === "manual"} onClick={() => setTab("manual")}>
            Manual
          </TabButton>
          <TabButton active={tab === "awork"} onClick={() => setTab("awork")}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Import from awork
          </TabButton>
        </div>

        {tab === "manual" ? (
          <ManualTab onDone={() => setOpen(false)} />
        ) : (
          <AworkImportTab onDone={() => setOpen(false)} />
        )}
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

function ManualTab({ onDone }: { onDone: () => void }) {
  const create = useCreateCustomer();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const customer = await create.mutateAsync({
        name: values.name,
        notes: values.notes ?? null,
      });
      toast.success(`Customer "${customer.name}" created`);
      reset();
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create customer",
      );
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

function AworkImportTab({ onDone }: { onDone: () => void }) {
  const [q, setQ] = useState("");
  const list = useAworkCompanies({ mapped: false });
  const imp = useImportCustomerFromAwork();

  const filtered = useMemo(() => {
    if (q.length < 2) return list.data ?? [];
    const needle = q.toLowerCase();
    return (list.data ?? []).filter((c) =>
      (c.name ?? "").toLowerCase().includes(needle),
    );
  }, [q, list.data]);

  async function importCompany(id: string, name: string) {
    try {
      await imp.mutateAsync({ awork_company_id: id });
      toast.success(`Imported "${name}" as a new customer`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="space-y-3 py-4">
      <Input
        placeholder="Filter awork companies by name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div className="max-h-[55vh] overflow-y-auto rounded-md border">
        {list.isLoading && (
          <div className="space-y-1.5 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
        {!list.isLoading && filtered.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            No unmapped awork companies match. (After `dante awork sync`
            you&apos;ll see the latest catalog.)
          </p>
        )}
        {filtered.length > 0 && (
          <ul className="divide-y text-sm">
            {filtered.slice(0, 200).map((c) => (
              <li
                key={c.awork_company_id}
                className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{c.name}</span>
                    {c.is_external && (
                      <Badge variant="outline">external</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {c.projects_count ?? 0} awork projects
                    {(c.projects_in_progress_count ?? 0) > 0 && (
                      <> ({c.projects_in_progress_count} active)</>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => importCompany(c.awork_company_id, c.name ?? "")}
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
        Imports create a new customer named after the awork company and link
        them so future awork project imports auto-pick the right customer.
      </p>
    </div>
  );
}
