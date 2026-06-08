/** Zod schemas at the awork API boundary.
 *
 * The schemas only validate the fields the sync actually reads — every
 * resource is `.passthrough()`-ed so unknown new fields from awork's
 * side don't break us. The aim is compile-time confidence on what we
 * touch, not a full mirror of awork's OpenAPI.
 *
 * Field-level shape decisions:
 *   - Dates that come as ISO strings are kept as `string` (the sync
 *     converts to Date / date-only at the call site).
 *   - Booleans + numbers are accepted as `null` because awork returns
 *     null for fields a user hasn't filled in.
 *   - Object subtrees we read fields from (e.g. `projectStatus.name`)
 *     get their own nested schema so a rename surfaces immediately.
 *
 * Invalid items are dropped with a logger warning — losing one row is
 * better than failing the whole sync over an unexpected payload.
 */
import { z } from "zod";

import { log } from "@/lib/logger";

const dateStringOrNull = z.string().nullish();

export const AworkCompanySchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    isExternal: z.boolean().nullish(),
    projectsCount: z.number().nullish(),
    projectsInProgressCount: z.number().nullish(),
    createdOn: dateStringOrNull,
    updatedOn: dateStringOrNull,
  })
  .passthrough();
export type AworkCompany = z.infer<typeof AworkCompanySchema>;

const ContactInfoSchema = z
  .object({
    type: z.string().nullish(),
    subType: z.string().nullish(),
    value: z.string().nullish(),
  })
  .passthrough();

export const AworkUserSchema = z
  .object({
    id: z.string(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    position: z.string().nullish(),
    title: z.string().nullish(),
    isAgent: z.boolean().nullish(),
    isArchived: z.boolean().nullish(),
    isDeactivated: z.boolean().nullish(),
    isExternal: z.boolean().nullish(),
    status: z.string().nullish(),
    createdOn: dateStringOrNull,
    userContactInfos: z.array(ContactInfoSchema).nullish(),
  })
  .passthrough();
export type AworkUser = z.infer<typeof AworkUserSchema>;

const ProjectStatusSchema = z
  .object({
    type: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();

const CustomFieldValueSchema = z
  .object({
    customFieldDefinitionId: z.string().nullish(),
    // awork returns one of `numberValue` / `textValue` / `stringValue`
    // depending on the field's type; we read all three at the consumer.
    numberValue: z.number().nullish(),
    textValue: z.string().nullish(),
    stringValue: z.string().nullish(),
  })
  .passthrough();

export const AworkProjectSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    projectKey: z.string().nullish(),
    companyId: z.string().nullish(),
    isBillableByDefault: z.boolean().nullish(),
    isExternal: z.boolean().nullish(),
    isPrivate: z.boolean().nullish(),
    isRetainer: z.boolean().nullish(),
    projectStatusId: z.string().nullish(),
    description: z.string().nullish(),
    tasksCount: z.number().nullish(),
    tasksDoneCount: z.number().nullish(),
    createdOn: dateStringOrNull,
    updatedOn: dateStringOrNull,
    startDate: dateStringOrNull,
    dueDate: dateStringOrNull,
    closedOn: dateStringOrNull,
    timeBudget: z.number().nullish(),
    projectStatus: ProjectStatusSchema.nullish(),
    customFields: z.array(CustomFieldValueSchema).nullish(),
  })
  .passthrough();
export type AworkProject = z.infer<typeof AworkProjectSchema>;
export type AworkCustomFieldValue = z.infer<typeof CustomFieldValueSchema>;

const TypeOfWorkSchema = z
  .object({
    id: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();

export const AworkTimeEntrySchema = z
  .object({
    id: z.string(),
    userId: z.string().nullish(),
    projectId: z.string().nullish(),
    taskId: z.string().nullish(),
    startDateLocal: dateStringOrNull,
    startDateUtc: dateStringOrNull,
    endDateUtc: dateStringOrNull,
    duration: z.number().nullish(),
    isBillable: z.boolean().nullish(),
    isBilled: z.boolean().nullish(),
    note: z.string().nullish(),
    typeOfWork: TypeOfWorkSchema.nullish(),
  })
  .passthrough();
export type AworkTimeEntry = z.infer<typeof AworkTimeEntrySchema>;

export const AworkCustomFieldDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    type: z.string().nullish(),
  })
  .passthrough();
export type AworkCustomFieldDefinition = z.infer<
  typeof AworkCustomFieldDefinitionSchema
>;

/** Parse an array of awork items, dropping malformed entries with a
 * structured warning. `resource` is used in the log line so operators
 * can grep for spikes in `awork_parse_failed` per resource. */
export function parseList<T>(
  schema: z.ZodType<T>,
  items: unknown[],
  resource: string,
): T[] {
  const out: T[] = [];
  let dropped = 0;
  for (const raw of items) {
    const r = schema.safeParse(raw);
    if (r.success) {
      out.push(r.data);
    } else {
      dropped += 1;
      if (dropped <= 3) {
        // Cap noise: log up to 3 detailed failures per resource per run.
        log.warn("awork_parse_failed", {
          resource,
          issue: r.error.issues[0]?.message,
          path: r.error.issues[0]?.path,
        });
      }
    }
  }
  if (dropped > 3) {
    log.warn("awork_parse_failed_truncated", { resource, total_dropped: dropped });
  }
  return out;
}
