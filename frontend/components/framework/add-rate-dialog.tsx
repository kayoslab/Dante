"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus } from "lucide-react";
import { toast } from "sonner";

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

import { useAddFrameworkRate } from "@/lib/api/frameworks";
import { useAddProjectRate } from "@/lib/api/projects";

const schema = z.object({
  profile: z.string().min(1, "profile is required").max(120),
  daily_rate_eur: z.coerce.number().positive("must be > 0"),
  valid_from: z.string().optional().or(z.literal("")),
});
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

type Props =
  | { parent: "framework"; framework_id: number; defaultValidFrom?: string }
  | { parent: "project"; project_id: number; defaultValidFrom?: string };

export function AddRateDialog(props: Props) {
  const [open, setOpen] = useState(false);

  const addFrameworkRate = useAddFrameworkRate(
    props.parent === "framework" ? props.framework_id : 0,
  );
  const addProjectRate = useAddProjectRate(
    props.parent === "project" ? props.project_id : 0,
  );
  const mutation = props.parent === "framework" ? addFrameworkRate : addProjectRate;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({
        profile: values.profile,
        daily_rate_eur: values.daily_rate_eur,
        valid_from: values.valid_from || null,
      });
      toast.success(`Rate for "${values.profile}" added`);
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            Add rate
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Add rate</DialogTitle>
            <DialogDescription>
              Multiple versions per (profile, valid_from) are allowed — that's
              how rate timelines work.
              {props.defaultValidFrom && (
                <> Defaults to {props.defaultValidFrom} if not set.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile">Profile</Label>
              <Input
                id="profile"
                placeholder="e.g. senior, junior, Information Security Manager"
                {...register("profile")}
                autoFocus
              />
              {errors.profile && (
                <p className="text-sm text-red-600">{errors.profile.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="daily_rate_eur">Daily rate (EUR)</Label>
                <Input
                  id="daily_rate_eur"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register("daily_rate_eur")}
                />
                {errors.daily_rate_eur && (
                  <p className="text-sm text-red-600">
                    {errors.daily_rate_eur.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="valid_from">Valid from</Label>
                <Input
                  id="valid_from"
                  type="date"
                  defaultValue={props.defaultValidFrom ?? ""}
                  {...register("valid_from")}
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
