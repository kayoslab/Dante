"use client";

import { useState, type ReactElement, type ReactNode } from "react";
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Resolver,
  type UseFormReturn,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ZodType } from "zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Generic "add or edit one entity" dialog.
 *
 * Subsumes the recurring trigger → header → form (Zod + react-hook-form)
 * → footer pattern with built-in submit handling, toast on success/failure,
 * close-on-success, and an isDirty/isPending-aware submit button.
 *
 * The form fields themselves are caller-controlled via the `children`
 * render prop — `form.register`, `form.formState.errors`, etc.
 *
 * Example (edit):
 *
 *   <FormDialog
 *     trigger={<Button variant="outline" size="sm"><Pencil/> Edit</Button>}
 *     title="Edit customer"
 *     schema={customerSchema}
 *     defaultValues={{ name: customer.name, notes: customer.notes ?? "" }}
 *     mutation={useUpdateCustomer(customerId)}
 *     buildPayload={(v) => ({ name: v.name, notes: v.notes ?? null })}
 *     successMessage="Customer updated"
 *     submitLabel="Save"
 *     disableSubmitWhilePristine
 *   >
 *     {(form) => (
 *       <FormField label="Name" error={form.formState.errors.name}>
 *         <Input {...form.register("name")} autoFocus />
 *       </FormField>
 *     )}
 *   </FormDialog>
 */
export function FormDialog<TValues extends FieldValues>({
  trigger,
  title,
  description,
  schema,
  defaultValues,
  mutation,
  buildPayload,
  successMessage,
  errorMessage,
  submitLabel = "Save",
  pendingLabel = "Saving…",
  cancelLabel = "Cancel",
  disableSubmitWhilePristine,
  dialogContentClassName,
  resetOnOpen,
  onSuccess,
  children,
}: {
  trigger: ReactElement;
  title: string;
  description?: ReactNode;
  schema: ZodType<TValues>;
  defaultValues: DefaultValues<TValues>;
  mutation: {
    mutateAsync: (payload: never) => Promise<unknown>;
    isPending: boolean;
  };
  /** Map form values to mutation payload. Defaults to passing values as-is. */
  buildPayload?: (values: TValues) => unknown;
  successMessage?: string;
  /** Override the default `err.message` toast text. */
  errorMessage?: string;
  submitLabel?: string;
  pendingLabel?: string;
  cancelLabel?: string;
  /** Edit dialogs typically want the submit disabled until the form is
   *  dirty so the user can't fire a no-op mutation. Add dialogs leave it
   *  enabled so empty-form submission shows validation errors. */
  disableSubmitWhilePristine?: boolean;
  /** Forwarded to `<DialogContent>` for width overrides (e.g. `sm:max-w-2xl`). */
  dialogContentClassName?: string;
  /** When true, the form is reset to defaults each time the dialog opens —
   *  matches the edit-dialog convention. Add dialogs typically want
   *  `false` (preserve in-progress input across accidental closes). */
  resetOnOpen?: boolean;
  /** Fired after a successful mutation and toast. Use for parent-side
   *  invalidations or navigation; close-on-success is automatic. */
  onSuccess?: (data: unknown) => void;
  children: (form: UseFormReturn<TValues>) => ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // zodResolver's overloads don't always infer our schema-input through
  // the generic parameter; cast keeps the public API clean for callers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const form = useForm<TValues>({
    resolver: zodResolver(schema as never) as unknown as Resolver<TValues>,
    defaultValues,
  });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && resetOnOpen) form.reset(defaultValues);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = buildPayload ? buildPayload(values) : values;
      const result = await mutation.mutateAsync(payload as never);
      if (successMessage) toast.success(successMessage);
      onSuccess?.(result);
      setOpen(false);
    } catch (err) {
      const fallback = err instanceof Error ? err.message : "Failed";
      toast.error(errorMessage ?? fallback);
    }
  });

  const submitDisabled =
    mutation.isPending ||
    form.formState.isSubmitting ||
    (disableSubmitWhilePristine && !form.formState.isDirty);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={trigger} />
      <DialogContent className={dialogContentClassName}>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">{children(form)}</DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
            >
              {cancelLabel}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {mutation.isPending ? pendingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Small label/error wrapper for individual form fields. Pairs naturally
 *  with `<FormDialog>` but works on its own anywhere we use Zod +
 *  react-hook-form. */
export function FormField({
  label,
  htmlFor,
  error,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  /** Pass the corresponding `form.formState.errors[name]` entry. */
  error?: { message?: string };
  /** Optional help text rendered below the input. */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
      >
        {label}
      </label>
      {children}
      {error?.message && (
        <p className="text-sm text-red-600">{String(error.message)}</p>
      )}
      {hint && !error?.message && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
