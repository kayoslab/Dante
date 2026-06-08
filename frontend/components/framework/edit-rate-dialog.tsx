"use client";

import { Pencil } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { FormDialog, FormField } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { useUpdateFrameworkRate } from "@/lib/api/frameworks";
import { useUpdateProjectRate } from "@/lib/api/projects";
import { requiredPositiveNumber } from "@/lib/zod-helpers";

const schema = z.object({
  daily_rate_eur: requiredPositiveNumber,
});

type Props =
  | {
      parent: "framework";
      framework_id: number;
      profile: string;
      valid_from: string;
      currentRate: string;
    }
  | {
      parent: "project";
      project_id: number;
      profile: string;
      valid_from: string;
      currentRate: string;
    };

export function EditRateDialog(props: Props) {
  const updateFrameworkRate = useUpdateFrameworkRate(
    props.parent === "framework" ? props.framework_id : 0,
  );
  const updateProjectRate = useUpdateProjectRate(
    props.parent === "project" ? props.project_id : 0,
  );
  const mutation =
    props.parent === "framework" ? updateFrameworkRate : updateProjectRate;

  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="sm">
          <Pencil className="h-4 w-4" />
        </Button>
      }
      title={`Update rate for "${props.profile}"`}
      description={
        <>
          Effective from {props.valid_from}. This changes the existing version
          in place — to add a new effective date instead, use{" "}
          <strong>Add rate</strong>.
        </>
      }
      schema={schema}
      // currentRate is a `string` from the API; zod's preprocess coerces
      // it on submit. Cast around the TInput≠TOutput gap.
      defaultValues={{
        daily_rate_eur: props.currentRate as unknown as number,
      }}
      mutation={mutation}
      buildPayload={(v) => ({
        profile: props.profile,
        valid_from: props.valid_from,
        daily_rate_eur: v.daily_rate_eur,
      })}
      successMessage="Rate updated"
      disableSubmitWhilePristine
      resetOnOpen
    >
      {(form) => (
        <FormField
          label="Daily rate (EUR)"
          htmlFor="daily_rate_eur"
          error={form.formState.errors.daily_rate_eur}
        >
          <Input
            id="daily_rate_eur"
            type="number"
            step="0.01"
            min="0"
            autoFocus
            {...form.register("daily_rate_eur")}
          />
        </FormField>
      )}
    </FormDialog>
  );
}
