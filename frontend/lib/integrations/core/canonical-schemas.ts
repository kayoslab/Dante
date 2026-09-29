/** Zod schemas for the canonical records adapters return.
 *
 * The TypeScript types in `types.ts` are the contract at compile time;
 * these schemas are the same contract at run time, used by the adapter
 * conformance suite (`conformance.ts`) to check what a pull method
 * actually emits against fixture input. Keep the two in step — each
 * schema is `satisfies`-checked against its type below.
 */
import { z } from "zod";

import type { Capability } from "./capabilities";
import type {
  CanonicalAbsence,
  CanonicalBooking,
  CanonicalCompany,
  CanonicalCompensation,
  CanonicalEmployee,
  CanonicalPerson,
  CanonicalProject,
  CanonicalTimeEntry,
} from "./types";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const extra = z.record(z.string(), z.unknown());
const nullableDate = z.date().nullable();
const externalId = z.string().min(1);

export const CanonicalEmployeeSchema = z.object({
  external_id: externalId,
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  status: z.string().nullable(),
  department: z.string().nullable(),
  position: z.string().nullable(),
  subcompany: z.string().nullable(),
  office: z.string().nullable(),
  hire_date: dateString.nullable(),
  contract_end_date: dateString.nullable(),
  employment_end_date: dateString.nullable(),
  employment_type: z.string().nullable(),
  weekly_working_hours: z.number().nullable(),
  supervisor_external_id: z.string().nullable(),
  fix_salary: z.number().nullable(),
  fix_salary_interval: z.string().nullable(),
  hourly_salary: z.number().nullable(),
  cost_center: z.string().nullable(),
  gender: z.string().nullable(),
  probation_period_end: dateString.nullable(),
  birth_date: dateString.nullable(),
  nationality: z.string().nullable(),
  notice_period_probation: z.string().nullable(),
  absence_entitlement: z.unknown(),
  raw: z.unknown(),
}) satisfies z.ZodType<CanonicalEmployee>;

export const CanonicalPersonSchema = z.object({
  external_id: externalId,
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  status: z.string().nullable(),
  is_active: z.boolean().nullable(),
  is_external: z.boolean().nullable(),
  extra,
  source_updated_at: nullableDate,
}) satisfies z.ZodType<CanonicalPerson>;

export const CanonicalCompanySchema = z.object({
  external_id: externalId,
  name: z.string().nullable(),
  is_external: z.boolean().nullable(),
  extra,
  source_updated_at: nullableDate,
}) satisfies z.ZodType<CanonicalCompany>;

export const CanonicalProjectSchema = z.object({
  external_id: externalId,
  name: z.string().nullable(),
  project_key: z.string().nullable(),
  external_company_id: z.string().nullable(),
  parent_external_id: z.string().nullable(),
  billable: z.boolean().nullable(),
  active: z.boolean().nullable(),
  status_type: z.string().nullable(),
  status_name: z.string().nullable(),
  start_date: dateString.nullable(),
  due_date: dateString.nullable(),
  closed_on: dateString.nullable(),
  time_budget_seconds: z.number().nullable(),
  description: z.string().nullable(),
  extra,
  source_updated_at: nullableDate,
}) satisfies z.ZodType<CanonicalProject>;

export const CanonicalAbsenceSchema = z.object({
  external_id: externalId,
  external_person_id: externalId,
  type_name: z.string().nullable(),
  start_date: dateString,
  end_date: dateString,
  half_day_start: z.boolean().nullable(),
  half_day_end: z.boolean().nullable(),
  days_count: z.number().nullable(),
  status: z.string().nullable(),
  comment: z.string().nullable(),
}) satisfies z.ZodType<CanonicalAbsence>;

export const CanonicalCompensationSchema = z.object({
  external_id: externalId,
  external_person_id: externalId,
  effective_from: dateString.nullable(),
  amount_value: z.number().nullable(),
  amount_currency: z.string().nullable(),
  interval: z.string().nullable(),
  category: z.string().nullable(),
  type_name: z.string().nullable(),
  legal_entity_id: z.string().nullable(),
  weekly_working_hours: z.number().nullable(),
  full_time_weekly_working_hours: z.number().nullable(),
}) satisfies z.ZodType<CanonicalCompensation>;

export const CanonicalTimeEntrySchema = z.object({
  external_id: externalId,
  external_person_id: z.string().nullable(),
  external_project_id: z.string().nullable(),
  external_task_id: z.string().nullable(),
  work_date: dateString,
  start_at: nullableDate,
  end_at: nullableDate,
  duration_minutes: z.number().int().nonnegative(),
  is_billable: z.boolean().nullable(),
  is_billed: z.boolean().nullable(),
  status: z.string().nullable(),
  note: z.string().nullable(),
  type_of_work: z.string().nullable(),
  extra,
  source_updated_at: nullableDate,
}) satisfies z.ZodType<CanonicalTimeEntry>;

export const CanonicalBookingSchema = z.object({
  external_id: externalId,
  external_person_id: externalId,
  external_project_id: externalId,
  start_date: dateString,
  end_date: dateString,
  duration_seconds: z.number().int().nonnegative(),
  description: z.string().nullable(),
  extra,
  source_created_at: nullableDate,
  source_updated_at: nullableDate,
}) satisfies z.ZodType<CanonicalBooking>;

/** Record schema per capability, and whether the pull method returns a
 *  bare array or a `Pulled<T>` envelope. */
export const CAPABILITY_RECORD_SCHEMA: Record<Capability, { schema: z.ZodType; envelope: boolean }> = {
  people: { schema: CanonicalEmployeeSchema, envelope: false },
  external_contributors: { schema: CanonicalPersonSchema, envelope: false },
  companies: { schema: CanonicalCompanySchema, envelope: true },
  projects: { schema: CanonicalProjectSchema, envelope: true },
  absences: { schema: CanonicalAbsenceSchema, envelope: false },
  compensations: { schema: CanonicalCompensationSchema, envelope: false },
  time_entries: { schema: CanonicalTimeEntrySchema, envelope: true },
  planned_bookings: { schema: CanonicalBookingSchema, envelope: false },
};
