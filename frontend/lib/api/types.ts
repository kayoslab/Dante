/** Wire-format types for HTTP routes under `/api/*`.
 *
 * This file is the source of truth for the JSON shape exchanged between
 * the FE and the route handlers. Server-side query helpers in
 * `lib/db/queries/*` export their own narrower types; this module is
 * specifically the wire surface and stays flat by design (the move to
 * per-feature wire types adds churn without functional gain).
 *
 * `APIError` is thrown by `apiGet` when the response envelope matches the
 * `{ detail, code }` shape that the route handlers return on error.
 */

export type APIErrorPayload = {
  detail: string;
  code: string;
};

export function isAPIError(value: unknown): value is APIErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "detail" in value &&
    "code" in value
  );
}

export class APIError extends Error {
  code: string;
  constructor(detail: string, code: string) {
    super(detail);
    this.name = "APIError";
    this.code = code;
  }
}

export type AssignmentCreate = {
        /** Employee Id */
        employee_id?: number | null;
        /** Freelancer Id */
        freelancer_id?: number | null;
        /** Project Id */
        project_id: number;
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct: number;
        /**
         * Start Date
         * Format: date
         */
        start_date: string;
        /** End Date */
        end_date?: string | null;
        /** Daily Rate Override Eur */
        daily_rate_override_eur?: number | null;
        /** Daily Cost Override Eur */
        daily_cost_override_eur?: number | null;
        /** Notes */
        notes?: string | null;
    };

export type AssignmentDetail = {
        /** Assignment Id */
        assignment_id: number;
        /**
         * Kind
         * @enum {string}
         */
        kind: "employee" | "freelancer";
        /** Who Name */
        who_name: string;
        /** Employee Id */
        employee_id?: number | null;
        /** Freelancer Id */
        freelancer_id?: number | null;
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /** Customer Name */
        customer_name: string;
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct: string;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
        /** Daily Rate Override Eur */
        daily_rate_override_eur?: string | null;
        /** Daily Cost Override Eur */
        daily_cost_override_eur?: string | null;
        /** Effective Profile */
        effective_profile?: string | null;
        /** Effective Daily Rate Eur */
        effective_daily_rate_eur?: string | null;
        /** Rate Source */
        rate_source?: string | null;
        /** Notes */
        notes?: string | null;
        /**
         * Created At
         * Format: date-time
         */
        created_at: string;
    };


export type AssignmentUpdate = {
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct?: number | null;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
        /** Daily Rate Override Eur */
        daily_rate_override_eur?: number | null;
        /** Daily Cost Override Eur */
        daily_cost_override_eur?: number | null;
        /** Notes */
        notes?: string | null;
    };

export type AworkCompanyItem = {
        /** Awork Company Id */
        awork_company_id: string;
        /** Name */
        name?: string | null;
        /** Is External */
        is_external?: boolean | null;
        /** Projects Count */
        projects_count?: number | null;
        /** Projects In Progress Count */
        projects_in_progress_count?: number | null;
        /** Mapped To Customer Id */
        mapped_to_customer_id?: number | null;
        /** Mapped To Customer Name */
        mapped_to_customer_name?: string | null;
    };




export type AworkImportableProject = {
        /** Awork Project Id */
        awork_project_id: string;
        /** Name */
        name?: string | null;
        /** Project Key */
        project_key?: string | null;
        /** Awork Company Id */
        awork_company_id?: string | null;
        /** Awork Company Name */
        awork_company_name?: string | null;
        /** Start Date */
        start_date?: string | null;
        /** Due Date */
        due_date?: string | null;
        /** Closed On */
        closed_on?: string | null;
        /** Time Budget Hours */
        time_budget_hours?: number | null;
        /** Project Status Type */
        project_status_type?: string | null;
        /** Project Status Name */
        project_status_name?: string | null;
        /** Description */
        description?: string | null;
        /**
         * N Time Entries
         * @default 0
         */
        n_time_entries: number;
        /** Mapped To Customer Id */
        mapped_to_customer_id?: number | null;
        /** Mapped To Customer Name */
        mapped_to_customer_name?: string | null;
    };

export type AworkProjectItem = {
        /** Awork Project Id */
        awork_project_id: string;
        /** Name */
        name?: string | null;
        /** Project Key */
        project_key?: string | null;
        /** Awork Company Id */
        awork_company_id?: string | null;
        /** Awork Company Name */
        awork_company_name?: string | null;
        /** Is Billable By Default */
        is_billable_by_default?: boolean | null;
        /** Is External */
        is_external?: boolean | null;
        /** Mapped To Project Id */
        mapped_to_project_id?: number | null;
        /** Mapped To Project Name */
        mapped_to_project_name?: string | null;
        /** Mapped To Customer Name */
        mapped_to_customer_name?: string | null;
        /**
         * N Time Entries
         * @default 0
         */
        n_time_entries: number;
    };


export type AworkUserItem = {
        /** Awork User Id */
        awork_user_id: string;
        /** First Name */
        first_name?: string | null;
        /** Last Name */
        last_name?: string | null;
        /** Email */
        email?: string | null;
        /** Position */
        position?: string | null;
        /** Title */
        title?: string | null;
        /** Is Archived */
        is_archived?: boolean | null;
        /** Is Deactivated */
        is_deactivated?: boolean | null;
        /** Is External */
        is_external?: boolean | null;
        /** Mapped To Employee Id */
        mapped_to_employee_id?: number | null;
        /** Mapped To Employee Name */
        mapped_to_employee_name?: string | null;
        /**
         * N Time Entries
         * @default 0
         */
        n_time_entries: number;
    };


export type BenchSummary = {
        /** Total Loaded Cost */
        total_loaded_cost: string;
        /** Total Unallocated Cost */
        total_unallocated_cost: string;
    };

export type EmployeeRef = {
        employee_id: number;
        first_name?: string | null;
        last_name?: string | null;
    };

export type UnassignedTrackedRow = {
        employee_id?: number | null;
        who_name?: string | null;
        role_tier?: string | null;
        tracked_hours: string;
        tracked_days: string;
        sources: string[];
        revenue?: string | null;
        cost: string;
        margin?: string | null;
        rate_unresolved_days: number;
    };

export type CalendarAssignment = {
        assignment_id: number;
        customer_name: string;
        project_name: string;
        profile?: string | null;
        allocation_pct: string;
        daily_rate_eur?: string | null;
    };

export type CalendarTrackedEntry = {
        project_name: string;
        hours: number;
        source: string;
    };

export type CalendarPlannedEntry = {
        project_name: string;
        hours: number;
    };

export type CalendarCell = {
        /** Employee Id */
        employee_id: number;
        /** Date */
        date: string;
        /** Allocation Pct */
        allocation_pct: string;
        /**
         * Cell load as a fraction of an 8h day. Which signal feeds it
         * depends on `load_kind`: past days score awork tracked hours
         * only, or Personio attendance when there are none (> 1.0 =
         * overtime); today and future days score the plan
         * only — sum over projects of max(manual_allocation,
         * awork_planned/8) — (> 1.0 = overbooked). Manual + awork on
         * the same project collapse to max (same work, two views)
         * rather than summing. Not scaled by weekly FTE.
         */
        load: string;
        /**
         * Which signal `load` was computed from: "actual" for days
         * before today (awork tracked hours), "planned" for today and
         * later (manual allocation + awork Planner).
         */
        load_kind: "planned" | "actual";
        /**
         * For `load_kind = "actual"`: which system the hours came from.
         * "awork" when any awork time exists for the day, "personio"
         * when none does and Personio attendance stood in, null when
         * nothing was tracked anywhere. Always null on planned cells.
         */
        actual_source: "awork" | "personio" | null;
        /** On Vacation */
        on_vacation: boolean;
        /** Vacation Type */
        vacation_type?: string | null;
        /** Assignments */
        assignments: CalendarAssignment[];
        /**
         * Personio-attendance hours for this cell — the corner number on
         * the calendar grid. Compare against `allocation_pct` (= planned
         * load including awork bookings rolled up by the sync) to spot
         * "she was planned for 100% but clocked 4h" gaps.
         * @default 0
         */
        tracked_hours: number;
        /**
         * awork-time-entry hours for this cell. Surfaced in the tooltip
         * via `tracked_entries`; the corner number stays on the
         * Personio signal so the two numbers can be visually compared.
         * @default 0
         */
        awork_tracked_hours: number;
        /**
         * Tracked Entries
         * @default []
         */
        tracked_entries: CalendarTrackedEntry[];
        /**
         * Total planned hours for this cell, distributed per-day from
         * awork time bookings (planner data). Drives the cell color on
         * today + future days; on past days it's tooltip-only.
         * @default 0
         */
        planned_hours: number;
        /**
         * Per-project planned hours breakdown for the tooltip.
         * @default []
         */
        planned_entries: CalendarPlannedEntry[];
        /** Name of the state-only public holiday for this employee's office,
         * when the date is a public holiday in their German state but NOT
         * a federal holiday (e.g. Fronleichnam for Bavaria). Federal
         * holidays still come through `CalendarDay.public_holiday` at the
         * column level. Null otherwise. */
        local_public_holiday?: string | null;
    };

export type CalendarDay = {
        /** Date */
        date: string;
        /** Weekend */
        weekend: boolean;
        /** Today */
        today: boolean;
        /** Public Holiday */
        public_holiday?: string | null;
    };

export type CalendarEmployee = {
        /** Employee Id */
        employee_id: number;
        /** First Name */
        first_name: string;
        /** Last Name */
        last_name: string;
        /** Fte */
        fte?: number | null;
        /** Team */
        team?: string | null;
        /** Role Tier */
        role_tier?: string | null;
        /** Hire Date */
        hire_date?: string | null;
        /** Contract End Date */
        contract_end_date?: string | null;
    };

export type CalendarPayload = {
        /** Start */
        start: string;
        /** End */
        end: string;
        /** Days */
        days: CalendarDay[];
        /** Employees */
        employees: CalendarEmployee[];
        /** Cells */
        cells: CalendarCell[];
    };


export type ConsultantTrackedHoursRow = {
        /** Employee Id */
        employee_id: number;
        /** First Name */
        first_name?: string | null;
        /** Last Name */
        last_name?: string | null;
        /** Team */
        team?: string | null;
        /** Available Hours — contract working days × daily hours − absences (office-state holidays) */
        available_hours?: number;
        /** Billable Hours */
        billable_hours: number;
        /** Non Billable Hours */
        non_billable_hours: number;
        /** Untagged Hours */
        untagged_hours: number;
        /** Total Hours */
        total_hours: number;
    };

export type CustomerCreate = {
        /** Name */
        name: string;
        /** Notes */
        notes?: string | null;
    };

export type CustomerDetail = {
        /** Customer Id */
        customer_id: number;
        /** Name */
        name: string;
        /** Notes */
        notes?: string | null;
        /**
         * Created At
         * Format: date-time
         */
        created_at: string;
        /** Frameworks */
        frameworks: Framework[];
        /** Projects */
        projects: Project[];
    };

export type CustomerListItem = {
        /** Customer Id */
        customer_id: number;
        /** Name */
        name: string;
        /** N Frameworks */
        n_frameworks: number;
        /** N Projects */
        n_projects: number;
    };

export type CustomerUpdate = {
        /** Name */
        name?: string | null;
        /** Notes */
        notes?: string | null;
    };

export type EmployeeAllocation = {
        /** Assignment Id */
        assignment_id: number;
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /** Customer Name */
        customer_name: string;
        /** Billing Model */
        billing_model: string;
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct: string;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
        /** Is Active Today */
        is_active_today: boolean;
        /** Effective Daily Rate Eur */
        effective_daily_rate_eur?: string | null;
    };

export type EmployeeDetail = {
        /** Employee Id */
        employee_id: number;
        /** First Name */
        first_name?: string | null;
        /** Last Name */
        last_name?: string | null;
        /** Email */
        email?: string | null;
        /** Status */
        status?: string | null;
        /** Department */
        department?: string | null;
        /** Position */
        position?: string | null;
        /** Subcompany */
        subcompany?: string | null;
        /** Office */
        office?: string | null;
        /** Employment Type */
        employment_type?: string | null;
        /** Hire Date */
        hire_date?: string | null;
        /** Contract End Date */
        contract_end_date?: string | null;
        /** Employment End Date */
        employment_end_date?: string | null;
        /** Probation Period End */
        probation_period_end?: string | null;
        /** Notice Period Probation */
        notice_period_probation?: string | null;
        /** Weekly Working Hours */
        weekly_working_hours?: string | null;
        /** Fte */
        fte?: number | null;
        /** Fix Salary */
        fix_salary?: string | null;
        /** Fix Salary Interval */
        fix_salary_interval?: string | null;
        /** Hourly Salary */
        hourly_salary?: string | null;
        /** Cost Center */
        cost_center?: string | null;
        /** Gender */
        gender?: string | null;
        /** Nationality */
        nationality?: string | null;
        /** Birth Date */
        birth_date?: string | null;
        /** Supervisor Id */
        supervisor_id?: number | null;
        /** Supervisor Name */
        supervisor_name?: string | null;
        /**
         * Direct Reports
         * @default []
         */
        direct_reports: EmployeeRef[];
        /** Team */
        team?: string | null;
        /** Is Real Employee */
        is_real_employee?: boolean | null;
        /** Is Project Contributing */
        is_project_contributing?: boolean | null;
        /** Is Multi Org */
        is_multi_org?: boolean | null;
        /** Role Tier */
        role_tier?: string | null;
    };

export type EmployeeFlagsUpdate = {
        /** Is Real Employee */
        is_real_employee?: boolean | null;
        /** Is Project Contributing */
        is_project_contributing?: boolean | null;
        /** Is Multi Org */
        is_multi_org?: boolean | null;
        /** Team User */
        team_user?: string | null;
        /** Clear Team */
        clear_team?: boolean | null;
    };

export type EmployeeInspectPayload = {
        employee_id: number;
        sync_run_id?: number | null;
        sync_started_at?: string | null;
        // Flattened + redacted attributes. Bank/tax/government-ID fields
        // are returned as the literal "[redacted]" — see the SENSITIVE_ATTR_PATTERNS
        // block-list in app/api/inspect/[employee_id]/route.ts. The raw
        // Personio payload is intentionally NOT exposed via this route.
        attributes: {
            [key: string]: unknown;
        };
    };

export type EmployeeListItem = {
        /** Employee Id */
        employee_id: number;
        /** First Name */
        first_name?: string | null;
        /** Last Name */
        last_name?: string | null;
        /** Status */
        status?: string | null;
        /** Department */
        department?: string | null;
        /** Team */
        team?: string | null;
        /** Role Tier */
        role_tier?: string | null;
        /** Position */
        position?: string | null;
        /** Fte */
        fte?: number | null;
        /** Is Real Employee */
        is_real_employee?: boolean | null;
        /** Is Project Contributing */
        is_project_contributing?: boolean | null;
        /** Is Multi Org */
        is_multi_org?: boolean | null;
        /** Contract End Date */
        contract_end_date?: string | null;
    };

export type EmployeeMonthlyAssignmentRow = {
        /** Assignment Id */
        assignment_id: number;
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct: string;
        /** Active Working Days */
        active_working_days: number;
        /** Absence Days */
        absence_days: number;
        /** Billable Days */
        billable_days: number;
        /**
         * Rate Unresolved Days
         * @default 0
         */
        rate_unresolved_days: number;
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /** Customer Name */
        customer_name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** Billable revenue. For T&M: tracked hours × rate. For FP:
         * the employee's share of recognized revenue this month. */
        revenue: string;
        /** Forward-looking sibling for T&M: allocation × rate. Equal
         * to `revenue` for FP (recognition is already commitment-side
         * for fixed-price). */
        allocation_revenue: string;
    };

export type EmployeeMonthlyBreakdown = {
        /**
         * Entity Kind
         * @default employee
         * @constant
         */
        entity_kind: "employee";
        /** Entity Id */
        entity_id: number;
        /** Who Name */
        who_name: string;
        /** Status */
        status?: string | null;
        /** Is Real Employee */
        is_real_employee: boolean;
        /** Month */
        month: string;
        /** Month Start */
        month_start: string;
        /** Month End */
        month_end: string;
        /** Working Days In Month */
        working_days_in_month: number;
        /** Monthly Cost Full */
        monthly_cost_full?: string | null;
        /** Monthly Cost Basis */
        monthly_cost_basis: string;
        /** Billable revenue across all assignments. T&M assignments
         * contribute `tracked × rate`; FP assignments contribute the
         * employee's share of recognized revenue. */
        revenue: string;
        /** Forward-looking sibling: T&M assignments contribute
         * `allocation × rate`; FP assignments equal their `revenue`. */
        allocation_revenue: string;
        /** Margin */
        margin: string;
        /** Margin Pct */
        margin_pct?: string | null;
        /** Utilization Pct */
        utilization_pct: string;
        /** Fte */
        fte: string;
        /**
         * Rate Unresolved Days
         * @default 0
         */
        rate_unresolved_days: number;
        /** Assignments */
        assignments: EmployeeMonthlyAssignmentRow[];
        /**
         * Under Contract
         * @default true
         */
        under_contract: boolean;
        /** Hire Date */
        hire_date?: string | null;
        /** Employment End Date */
        employment_end_date?: string | null;
    };

export type EmployeeMonthlySeries = {
        /**
         * Entity Kind
         * @default employee
         * @constant
         */
        entity_kind: "employee";
        /** Entity Id */
        entity_id: number;
        /** From Month */
        from_month: string;
        /** To Month */
        to_month: string;
        /** Today Month */
        today_month: string;
        /** Points */
        points: EmployeeMonthlySeriesPoint[];
    };

export type EmployeeMonthlySeriesPoint = {
        /** Month */
        month: string;
        /** Under Contract */
        under_contract: boolean;
        /** Monthly Cost Full */
        monthly_cost_full?: string | null;
        /** Billable revenue (T&M tracked × rate + FP share). */
        revenue: string;
        /** Forward-looking sibling: T&M allocation × rate + FP share. */
        allocation_revenue: string;
        /** Margin */
        margin: string;
        /** Margin Pct */
        margin_pct?: string | null;
        /** Utilization Pct */
        utilization_pct: string;
        /** N Assignments */
        n_assignments: number;
        /** Is Forecast */
        is_forecast: boolean;
    };


export type EmployeeSalaryChange = {
        /** Effective From */
        effective_from?: string | null;
        /** Amount Value */
        amount_value?: string | null;
        /** Amount Currency */
        amount_currency?: string | null;
        /** Interval */
        interval?: string | null;
        /** Category */
        category?: string | null;
        /** Type Name */
        type_name?: string | null;
        /** Weekly Working Hours */
        weekly_working_hours?: string | null;
    };

export type EmployeeSalaryPoint = {
        /** Effective Date */
        effective_date: string;
        /** Annual Eur */
        annual_eur: string;
        /** Previous Annual Eur */
        previous_annual_eur?: string | null;
        /** Delta Eur */
        delta_eur?: string | null;
        /** Delta Pct */
        delta_pct?: string | null;
        /** Source */
        source?: string | null;
    };

export type EstimateRequest = {
        /** Employee Id */
        employee_id?: number | null;
        /** Freelancer Id */
        freelancer_id?: number | null;
        /** Project Id */
        project_id: number;
        /**
         * Allocation Pct
         * @default 1
         */
        allocation_pct: number;
        /** Profile */
        profile?: string | null;
        /** Rate Override */
        rate_override?: number | null;
        /** Cost Override */
        cost_override?: number | null;
        /** As Of */
        as_of?: string | null;
    };

export type EstimateResponse = {
        /**
         * Kind
         * @enum {string}
         */
        kind: "employee" | "freelancer";
        /** Entity Id */
        entity_id: number;
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /** Customer Name */
        customer_name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** As Of */
        as_of: string;
        /** Effective Profile */
        effective_profile?: string | null;
        /** Effective Daily Rate Eur */
        effective_daily_rate_eur?: string | null;
        /** Rate Source */
        rate_source: string;
        /** Monthly Cost Pre Alloc */
        monthly_cost_pre_alloc?: string | null;
        /** Monthly Cost Basis */
        monthly_cost_basis: string;
        /** Burden Factor */
        burden_factor: string;
        /** Monthly Revenue */
        monthly_revenue?: string | null;
        /** Monthly Gross Margin */
        monthly_gross_margin?: string | null;
        /** Monthly Gross Margin Pct */
        monthly_gross_margin_pct?: string | null;
        /** Agreed Amount Eur */
        agreed_amount_eur?: string | null;
        /** Planned Start Date */
        planned_start_date?: string | null;
        /** Planned End Date */
        planned_end_date?: string | null;
    };

export type Framework = {
        /** Framework Id */
        framework_id: number;
        /** Customer Id */
        customer_id: number;
        /** Name */
        name: string;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
    };

export type FrameworkCreate = {
        /** Customer Id */
        customer_id: number;
        /** Name */
        name: string;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
        /** Notes */
        notes?: string | null;
    };

export type FrameworkDetail = {
        /** Framework Id */
        framework_id: number;
        /** Customer Id */
        customer_id: number;
        /** Name */
        name: string;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
        /** Notes */
        notes?: string | null;
        /**
         * Created At
         * Format: date-time
         */
        created_at: string;
        /** Rates */
        rates: Rate[];
    };

export type FrameworkUpdate = {
        /** Name */
        name?: string | null;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
        /** Notes */
        notes?: string | null;
    };

export type FreelancerCreate = {
        /** Name */
        name: string;
        /** Daily Cost Eur */
        daily_cost_eur: number;
        /**
         * Status
         * @default active
         */
        status: string;
        /** Contact Email */
        contact_email?: string | null;
        /** Notes */
        notes?: string | null;
    };

export type FreelancerDetail = {
        /** Freelancer Id */
        freelancer_id: number;
        /** Name */
        name: string;
        /** Daily Cost Eur */
        daily_cost_eur: string;
        /** Status */
        status: string;
        /** Contact Email */
        contact_email?: string | null;
        /** Notes */
        notes?: string | null;
        /**
         * Created At
         * Format: date-time
         */
        created_at: string;
    };

export type FreelancerListItem = {
        /** Freelancer Id */
        freelancer_id: number;
        /** Name */
        name: string;
        /** Daily Cost Eur */
        daily_cost_eur: string;
        /** Status */
        status: string;
        /** Contact Email */
        contact_email?: string | null;
        /** Active Assigns */
        active_assigns: number;
    };

export type FreelancerMonthlyAssignmentRow = {
        /** Assignment Id */
        assignment_id: number;
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct: string;
        /** Active Working Days */
        active_working_days: number;
        /** Absence Days */
        absence_days: number;
        /** Billable Days */
        billable_days: number;
        /**
         * Rate Unresolved Days
         * @default 0
         */
        rate_unresolved_days: number;
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /** Customer Name */
        customer_name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** Revenue */
        revenue: string;
        /** Cost */
        cost: string;
    };

export type FreelancerMonthlyBreakdown = {
        /**
         * Entity Kind
         * @default freelancer
         * @constant
         */
        entity_kind: "freelancer";
        /** Entity Id */
        entity_id: number;
        /** Who Name */
        who_name: string;
        /** Month */
        month: string;
        /** Month Start */
        month_start: string;
        /** Month End */
        month_end: string;
        /** Working Days In Month */
        working_days_in_month: number;
        /** Cost */
        cost: string;
        /** Revenue */
        revenue: string;
        /** Margin */
        margin: string;
        /** Margin Pct */
        margin_pct?: string | null;
        /**
         * Rate Unresolved Days
         * @default 0
         */
        rate_unresolved_days: number;
        /** Assignments */
        assignments: FreelancerMonthlyAssignmentRow[];
    };

export type FreelancerMonthlySeries = {
        /**
         * Entity Kind
         * @default freelancer
         * @constant
         */
        entity_kind: "freelancer";
        /** Entity Id */
        entity_id: number;
        /** From Month */
        from_month: string;
        /** To Month */
        to_month: string;
        /** Today Month */
        today_month: string;
        /** Points */
        points: FreelancerMonthlySeriesPoint[];
    };

export type FreelancerMonthlySeriesPoint = {
        /** Month */
        month: string;
        /** Cost */
        cost: string;
        /** Revenue */
        revenue: string;
        /** Margin */
        margin: string;
        /** Margin Pct */
        margin_pct?: string | null;
        /** N Assignments */
        n_assignments: number;
        /** Is Forecast */
        is_forecast: boolean;
    };

export type FreelancerUpdate = {
        /** Name */
        name?: string | null;
        /** Daily Cost Eur */
        daily_cost_eur?: number | null;
        /** Status */
        status?: string | null;
        /** Contact Email */
        contact_email?: string | null;
        /** Notes */
        notes?: string | null;
    };

export type GenderGapRow = {
        /** Group Key */
        group_key: string | null;
        /** N Female */
        n_female?: number | null;
        /** Median Female */
        median_female?: number | null;
        /** N Male */
        n_male?: number | null;
        /** Median Male */
        median_male?: number | null;
        /** Gap Pct Female Below Male */
        gap_pct_female_below_male?: number | null;
    };


export type LoggedTimeConsultantRow = {
        /** Employee Id */
        employee_id?: number | null;
        /** Who Name */
        who_name?: string | null;
        /** Total Hours */
        total_hours: number;
        /** Total Days */
        total_days: string;
        /** First Log Date */
        first_log_date?: string | null;
        /** Last Log Date */
        last_log_date?: string | null;
        /**
         * Sources
         * @default []
         */
        sources: string[];
        /**
         * N Assignments
         * @default 0
         */
        n_assignments: number;
    };

export type MonthlyAssignmentRow = {
        /** Assignment Id */
        assignment_id: number;
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct: string;
        /** Active Working Days */
        active_working_days: number;
        /** Absence Days */
        absence_days: number;
        /** Billable Days */
        billable_days: number;
        /**
         * Rate Unresolved Days
         * @default 0
         */
        rate_unresolved_days: number;
        /**
         * Kind
         * @enum {string}
         */
        kind: "employee" | "freelancer";
        /** Who Name */
        who_name?: string | null;
        /** Fte */
        fte?: string | null;
        /**
         * Unpaid Absence Days
         * @default 0
         */
        unpaid_absence_days: number;
        /** Monthly Cost Full */
        monthly_cost_full?: string | null;
        /** Billable revenue: tracked hours × rate (T&M). Allocation does
         * NOT enter — a staffed-but-not-tracking consultant produces
         * zero revenue here while still carrying salary cost. */
        revenue?: string | null;
        /** Forward-looking sibling: allocation × rate × billable days.
         * What we'd bill if every committed allocation were tracked.
         * Used by forecasts; the gap vs `revenue` is the under-tracking
         * signal. */
        allocation_revenue?: string | null;
        /** Cost */
        cost: string;
        /** Margin */
        margin?: string | null;
        /** Burdened Cost */
        burdened_cost: string;
        /** Burdened Margin */
        burdened_margin?: string | null;
        /** Tracked Hours */
        tracked_hours?: string | null;
        /** Tracked Days */
        tracked_days?: string | null;
        /** Tracked Revenue — identical to `revenue` for T&M; kept as an
         * explicit alias so consumers that name the basis stay readable. */
        tracked_revenue?: string | null;
        /** Hours from `freelancer_time_entry` for this (assignment, month).
         * Only set for freelancer rows. Drives the read-only Tracked column
         * for freelancers; editing happens in the dedicated Hours card. */
        entered_hours?: string | null;
        /** 'manual' = SDM-entered, 'awork' = auto-filled from awork sync. */
        entered_hours_source?: ("manual" | "awork") | null;
    };

export type MonthlyBreakdown = {
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** Month */
        month: string;
        /** Month Start */
        month_start: string;
        /** Month End */
        month_end: string;
        /** Working Days In Month */
        working_days_in_month: number;
        /** Time budget hours configured on the project (FP). */
        time_budget_hours?: number | null;
        /** Planned start date (FP — drives schedule + recognition). */
        planned_start_date?: string | null;
        /** Planned end date (FP — drives schedule + recognition). */
        planned_end_date?: string | null;
        /** Agreed Amount Eur */
        agreed_amount_eur?: string | null;
        /** T&M billable revenue: tracked hours × rate, summed across
         * assignments + unassigned tracked. This is what the customer
         * is actually invoiced — not the allocation projection. */
        revenue?: string | null;
        /** Forward-looking sibling: allocation × rate, summed across
         * assignments only (unassigned tracked has no allocation).
         * Used by forecasts; the gap vs `revenue` is the under-tracking
         * signal at the project level. */
        allocation_revenue?: string | null;
        /** Cost */
        cost: string;
        /** Margin (revenue − cost, T&M only — built on billable revenue). */
        margin?: string | null;
        /** Margin Pct */
        margin_pct?: string | null;
        /** Burdened Cost */
        burdened_cost: string;
        /** Burdened Margin */
        burdened_margin?: string | null;
        /** Burdened Margin Pct */
        burdened_margin_pct?: string | null;
        /** Cumulative Cost */
        cumulative_cost?: string | null;
        /** Cumulative Recognized Revenue */
        cumulative_recognized_revenue?: string | null;
        /** Cumulative Margin */
        cumulative_margin?: string | null;
        /** Cumulative Margin Pct */
        cumulative_margin_pct?: string | null;
        /** Cumulative Burdened Cost */
        cumulative_burdened_cost?: string | null;
        /** Cumulative Burdened Margin */
        cumulative_burdened_margin?: string | null;
        /** Cumulative Burdened Margin Pct */
        cumulative_burdened_margin_pct?: string | null;
        /** Lifetime billable revenue (FP: recognized; T&M: tracked × rate). */
        cumulative_revenue?: string | null;
        /** Lifetime tracked person-days (tracked hours / 8), both models. */
        lifetime_tracked_person_days?: string | null;
        /** Lifetime tracked hours on the project (both billing models). */
        tracked_hours_lifetime?: string | null;
        /** Future planned hours from today to planned_end (FP only). */
        future_planned_hours?: string | null;
        /** Projected end-of-project allocated cost (FP only). */
        projected_cost?: string | null;
        /** Projected end-of-project burdened cost (FP only). */
        projected_burdened_cost?: string | null;
        /** agreed_amount − projected_cost (FP only). */
        projected_margin?: string | null;
        /** projected_margin / agreed_amount × 100 (FP only). */
        projected_margin_pct?: string | null;
        /** agreed_amount − projected_burdened_cost (FP only). */
        projected_burdened_margin?: string | null;
        /** projected_burdened_margin / agreed_amount × 100 (FP only). */
        projected_burdened_margin_pct?: string | null;
        /** Pct Complete */
        pct_complete?: string | null;
        /** Recognition Method */
        recognition_method?: ("tracked_hours" | "timeline" | "none") | null;
        /**
         * Over Budget
         * @default false
         */
        over_budget: boolean;
        /**
         * Rate Unresolved Days
         * @default 0
         */
        rate_unresolved_days: number;
        /** Tracked Hours */
        tracked_hours?: string | null;
        /** Tracked Days */
        tracked_days?: string | null;
        /** Tracked Revenue */
        tracked_revenue?: string | null;
        /**
         * Has Personio Mapping
         * @default false
         */
        has_personio_mapping: boolean;
        /**
         * True when at least one freelancer_time_entry row exists for
         * an assignment on this project in this month. UI uses this to
         * decide whether to render the Tracked column for freelancers.
         * @default false
         */
        has_freelancer_hours: boolean;
        /** Total freelancer hours entered this month (all freelancer
         * assignments). Distinct from `tracked_hours`, which is
         * Personio/awork employee attendance only. */
        freelancer_hours?: string;
        /** Assignments */
        assignments: MonthlyAssignmentRow[];
        /**
         * Unassigned Tracked
         * @default []
         */
        unassigned_tracked: UnassignedTrackedRow[];
    };

export type MonthlySeries = {
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** Agreed Amount Eur */
        agreed_amount_eur?: string | null;
        /** From Month */
        from_month: string;
        /** To Month */
        to_month: string;
        /** Points */
        points: MonthlySeriesPoint[];
    };

export type MonthlySeriesPoint = {
        /** Month */
        month: string;
        /** Working Days In Month */
        working_days_in_month: number;
        /** N Assignments */
        n_assignments: number;
        /** Revenue */
        revenue?: string | null;
        /** Cost */
        cost: string;
        /** Margin */
        margin?: string | null;
        /** Margin Pct */
        margin_pct?: string | null;
        /** Cumulative Cost */
        cumulative_cost?: string | null;
        /** Remaining Budget */
        remaining_budget?: string | null;
        /** Recognized Revenue */
        recognized_revenue?: string | null;
        /** Recognized Margin */
        recognized_margin?: string | null;
        /** Cumulative Recognized Revenue */
        cumulative_recognized_revenue?: string | null;
        /** Cumulative Margin */
        cumulative_margin?: string | null;
        /** Pct Complete */
        pct_complete?: string | null;
        /**
         * Over Budget
         * @default false
         */
        over_budget: boolean;
        /** Recognition Method */
        recognition_method?: ("tracked_hours" | "timeline" | "none") | null;
        /**
         * Rate Unresolved Days
         * @default 0
         */
        rate_unresolved_days: number;
        /** Tracked Hours */
        tracked_hours?: string | null;
        /** Tracked Days */
        tracked_days?: string | null;
        /** Tracked Revenue */
        tracked_revenue?: string | null;
        /**
         * Has Personio Mapping
         * @default false
         */
        has_personio_mapping: boolean;
    };

export type PersonioProjectItem = {
        /** Personio Project Id */
        personio_project_id: string;
        /** Name */
        name: string;
        /** Active */
        active?: boolean | null;
        /** Parent Id */
        parent_id?: string | null;
        /** Parent Name */
        parent_name?: string | null;
        /** Mapped To Project Id */
        mapped_to_project_id?: number | null;
        /** Mapped To Project Name */
        mapped_to_project_name?: string | null;
        /** Mapped To Customer Name */
        mapped_to_customer_name?: string | null;
        /**
         * N Attendance Entries
         * @default 0
         */
        n_attendance_entries: number;
    };


/** Per-month detail returned by `/api/reports/portfolio-rentability/month`.
 * Mirrors the wire shape the report's income-statement client reads —
 * trimmed to the fields actually rendered. Segment totals (T&M cost /
 * margin, allocated total_cost), per-month FP recognized margin, and
 * the bench head counts + consultants list were dropped when the page
 * moved to an income-statement layout that derives everything from
 * loaded payroll + per-segment revenue. */
export type PortfolioMonthly = {
        /** Month */
        month: string;
        /** N Active Projects */
        n_active_projects: number;
        /** N Tm Projects */
        n_tm_projects: number;
        /** N Fp Projects */
        n_fp_projects: number;
        /** Tm Revenue */
        tm_revenue: string;
        /** Fp Recognized Revenue */
        fp_recognized_revenue?: string | null;
        /** Fp Cumulative Recognized */
        fp_cumulative_recognized?: string | null;
        /** Fp Cumulative Cost */
        fp_cumulative_cost?: string | null;
        /** Fp Cumulative Margin */
        fp_cumulative_margin?: string | null;
        /** Fp Cumulative Margin Pct */
        fp_cumulative_margin_pct?: string | null;
        /**
         * Fp N Over Budget
         * @default 0
         */
        fp_n_over_budget: number;
        bench: BenchSummary;
        /** Freelancer Cost — entered hours × daily rate ÷ 8 for the month */
        freelancer_cost?: string | null;
        /** Projects */
        projects: PortfolioProjectRow[];
    };

export type PortfolioProjectRow = {
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /** Customer Id (optional for backwards compatibility) */
        customer_id?: number;
        /** Customer Name */
        customer_name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** N Assignments */
        n_assignments: number;
        /** T&M: tracked × rate (billable). FP: recognized revenue. */
        revenue?: string | null;
        /** T&M forward-looking sibling: allocation × rate. Null for FP. */
        allocation_revenue?: string | null;
        /** Cost */
        cost: string;
        /** Margin */
        margin?: string | null;
        /** Margin Pct */
        margin_pct?: string | null;
        /** Recognition Method */
        recognition_method?: ("tracked_hours" | "timeline" | "none") | null;
        /**
         * Over Budget
         * @default false
         */
        over_budget: boolean;
        /** Pct Complete */
        pct_complete?: string | null;
        /** Months since project start where a freelancer assignment was active
         * but no `freelancer_time_entry` exists. Always-on across scopes
         * (Home + report). 0 = no gaps. */
        n_missing_freelancer_hours_months?: number;
    };

export type Project = {
        /** Project Id */
        project_id: number;
        /** Customer Id */
        customer_id: number;
        /** Name */
        name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** Status */
        status: string;
    };

export type ProjectAssignment = {
        /** Assignment Id */
        assignment_id: number;
        /**
         * Kind
         * @enum {string}
         */
        kind: "employee" | "freelancer";
        /** Who Name */
        who_name: string;
        /** Employee Id */
        employee_id?: number | null;
        /** Freelancer Id */
        freelancer_id?: number | null;
        /** Profile */
        profile?: string | null;
        /** Allocation Pct */
        allocation_pct: string;
        /** Start Date */
        start_date?: string | null;
        /** End Date */
        end_date?: string | null;
        /** Daily Rate Override Eur */
        daily_rate_override_eur?: string | null;
        /** Daily Cost Override Eur */
        daily_cost_override_eur?: string | null;
        /** Effective Profile */
        effective_profile?: string | null;
        /** Effective Daily Rate Eur */
        effective_daily_rate_eur?: string | null;
        /** Rate Source */
        rate_source?: string | null;
        /** Notes */
        notes?: string | null;
    };

export type ProjectCreate = {
        /** Customer Id */
        customer_id: number;
        /** Name */
        name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price" | "t-and-m" | "fixed-price";
        /** Framework Id */
        framework_id?: number | null;
        /** Agreed Amount Eur */
        agreed_amount_eur?: number | null;
        /** Planned Start Date */
        planned_start_date?: string | null;
        /** Planned End Date */
        planned_end_date?: string | null;
        /**
         * Status
         * @default active
         */
        status: string;
        /** Notes */
        notes?: string | null;
    };

export type ProjectDetail = {
        /** Project Id */
        project_id: number;
        /** Customer Id */
        customer_id: number;
        /** Customer Name */
        customer_name: string;
        /** Framework Id */
        framework_id?: number | null;
        /** Framework Name */
        framework_name?: string | null;
        /** Name */
        name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** Agreed Amount Eur */
        agreed_amount_eur?: string | null;
        /** Planned Start Date */
        planned_start_date?: string | null;
        /** Planned End Date */
        planned_end_date?: string | null;
        /** Status */
        status: string;
        /** Notes */
        notes?: string | null;
        /** Billable */
        billable: boolean;
        /**
         * Created At
         * Format: date-time
         */
        created_at: string;
        /** Rates */
        rates: Rate[];
        /**
         * Framework Rates
         * @default []
         */
        framework_rates: Rate[];
        /** Assignments */
        assignments: ProjectAssignment[];
        economics: ProjectEconomics;
    };

export type ProjectEconomics = {
        /** N Current Employees */
        n_current_employees: number;
        /** N Current Freelancers */
        n_current_freelancers: number;
        /** Total Allocation Now */
        total_allocation_now?: string | null;
        /** Monthly Revenue Now */
        monthly_revenue_now?: string | null;
        /** Monthly Internal Cost Now */
        monthly_internal_cost_now?: string | null;
        /** Monthly External Cost Now */
        monthly_external_cost_now?: string | null;
        /** Monthly Cost Now */
        monthly_cost_now?: string | null;
        /** Monthly Gross Margin Now */
        monthly_gross_margin_now?: string | null;
        /** Monthly Gross Margin Pct */
        monthly_gross_margin_pct?: string | null;
    };

export type ProjectListItem = {
        /** Project Id */
        project_id: number;
        /** Name */
        name: string;
        /** Customer Id */
        customer_id: number;
        /** Customer Name */
        customer_name: string;
        /**
         * Billing Model
         * @enum {string}
         */
        billing_model: "time_and_material" | "fixed_price";
        /** Status */
        status: string;
        /** Framework Id */
        framework_id?: number | null;
        /** Framework Name */
        framework_name?: string | null;
        /** Planned Start Date */
        planned_start_date?: string | null;
        /** Planned End Date */
        planned_end_date?: string | null;
    };

export type ProjectLoggedTimeSummary = {
        /** Project Id */
        project_id: number;
        /** Project Name */
        project_name: string;
        /** N Consultants */
        n_consultants: number;
        /** Total Hours */
        total_hours: number;
        /** Total Days */
        total_days: string;
        /** Consultants */
        consultants: LoggedTimeConsultantRow[];
    };

export type ProjectUpdate = {
        /** Name */
        name?: string | null;
        /** Framework Id */
        framework_id?: number | null;
        /**
         * Clear Framework
         * @default false
         */
        clear_framework: boolean;
        /** Agreed Amount Eur */
        agreed_amount_eur?: number | null;
        /** Planned Start Date */
        planned_start_date?: string | null;
        /** Planned End Date */
        planned_end_date?: string | null;
        /** Status */
        status?: string | null;
        /** Notes */
        notes?: string | null;
        /** Billable */
        billable?: boolean;
    };

export type Rate = {
        /** Profile */
        profile: string;
        /** Valid From */
        valid_from: string;
        /** Daily Rate Eur */
        daily_rate_eur: string;
    };

export type RateCreate = {
        /** Profile */
        profile: string;
        /** Daily Rate Eur */
        daily_rate_eur: number;
        /** Valid From */
        valid_from?: string | null;
    };


export type SalaryBandRow = {
        /** Group Key */
        group_key: string | null;
        /** N */
        n: number;
        /** Min */
        min: number;
        /** P25 */
        p25: number;
        /** Median */
        median: number;
        /** P75 */
        p75: number;
        /** Max */
        max: number;
    };

export type SalaryOutlierReason = {
        kind: "in_band" | "cross_band";
        label: string;
        reference: number;
        delta: number;
    };

export type SalaryOutlier = {
        employee_id: number;
        name: string;
        position: string | null;
        group_key: string;
        salary: number;
        reasons: SalaryOutlierReason[];
    };

export type Setting = {
        /** Key */
        key: string;
        /** Value */
        value: string;
        /** Description */
        description?: string | null;
        /** Updated At */
        updated_at?: string | null;
    };


export type TeamCreate = {
        /** Name */
        name: string;
    };

export type TeamDeleteResult = {
        /** Team Name */
        team_name: string;
        /**
         * Members Cleared
         * @default 0
         */
        members_cleared: number;
    };

export type TeamItem = {
        /** Team Name */
        team_name: string;
        /**
         * N Members
         * @default 0
         */
        n_members: number;
    };

export type TeamRename = {
        /** New Name */
        new_name: string;
    };

export type TrackedHoursMonth = {
        /** Month */
        month: string;
        /** Month Start */
        month_start: string;
        /** Month End */
        month_end: string;
        /** Working Days In Month */
        working_days_in_month: number;
        /** N Consultants */
        n_consultants: number;
        /** Total Available Hours — Σ per-consultant available (contract − absences) */
        total_available_hours?: number;
        /** Billable Util Pct — exact (unrounded) billable ÷ available × 100 */
        billable_util_pct?: number | null;
        /** Total Billable Hours */
        total_billable_hours: number;
        /** Total Non Billable Hours */
        total_non_billable_hours: number;
        /** Total Untagged Hours */
        total_untagged_hours: number;
        /** Total Hours */
        total_hours: number;
        /** Consultants */
        consultants: ConsultantTrackedHoursRow[];
    };


