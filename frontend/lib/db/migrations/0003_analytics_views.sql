-- Analytics views, moved out of lib/db/views*.sql so drizzle-kit migrate
-- replays them in order. All views use CREATE OR REPLACE so the migration is
-- idempotent.

--
-- Dependency order:
--   employee_role_tier         (uses employee_current + employee_annotation)
--   assignment_effective_rate  (uses assignment + project + customer + role_tier)
--   assignment_monthly_margin  (uses assignment_effective_rate + setting)
--   project_summary            (uses assignment_monthly_margin)

-- --------------------------------------------------------------------------
-- employee_role_tier: derive role_tier from position string, with optional
-- per-employee override from employee_annotation. Junior / senior / expert /
-- advanced ladder; default 'advanced'.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW employee_role_tier AS
SELECT
    ec.employee_id,
    ec.position,
    COALESCE(
        a.role_tier,
        CASE
            WHEN LOWER(ec.position) LIKE '%junior%'
              OR LOWER(ec.position) LIKE '%jr.%'
              OR LOWER(ec.position) LIKE '%werkstudent%'
              OR LOWER(ec.position) LIKE '%praktikant%'
              OR LOWER(ec.position) LIKE '%trainee%'   THEN 'junior'
            WHEN LOWER(ec.position) LIKE '%senior%'
              OR LOWER(ec.position) LIKE 'sr. %'
              OR LOWER(ec.position) LIKE 'sr.%'        THEN 'senior'
            WHEN LOWER(ec.position) LIKE '%head of%'
              OR LOWER(ec.position) LIKE '%director%'
              OR LOWER(ec.position) LIKE '%principal%'
              OR LOWER(ec.position) LIKE '%chief%'
              OR LOWER(ec.position) LIKE '%team lead%'
              OR LOWER(ec.position) LIKE '%teamlead%'
              OR LOWER(ec.position) LIKE '%expert%'    THEN 'expert'
            WHEN LOWER(ec.position) LIKE '%advanced%'
              OR LOWER(ec.position) LIKE '%adv. %'     THEN 'advanced'
            ELSE 'advanced'
        END
    ) AS role_tier
FROM employee_current ec
LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id;

-- --------------------------------------------------------------------------
-- assignment_effective_rate: per-assignment rate resolution. Three-tier
-- fallback (override → project_rate → framework_rate) keyed by the effective
-- profile, picking the most recent valid_from ≤ assignment.start_date.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW assignment_effective_rate AS
SELECT
    a.assignment_id,
    a.employee_id,
    a.freelancer_id,
    (a.freelancer_id IS NOT NULL) AS is_external,
    a.project_id,
    p.customer_id,
    c.name AS customer_name,
    p.name AS project_name,
    p.billing_model,
    p.status AS project_status,
    p.agreed_amount_eur,
    p.planned_start_date,
    p.planned_end_date,
    a.start_date,
    a.end_date,
    a.allocation_pct,
    COALESCE(a.profile, rt.role_tier) AS effective_profile,
    COALESCE(
        a.daily_rate_override_eur,
        (SELECT daily_rate_eur FROM project_rate pr
         WHERE pr.project_id = a.project_id
           AND pr.profile = COALESCE(a.profile, rt.role_tier)
           AND pr.valid_from <= a.start_date
         ORDER BY pr.valid_from DESC LIMIT 1),
        (SELECT daily_rate_eur FROM framework_rate fr
         WHERE fr.framework_id = p.framework_id
           AND fr.profile = COALESCE(a.profile, rt.role_tier)
           AND fr.valid_from <= a.start_date
         ORDER BY fr.valid_from DESC LIMIT 1)
    ) AS effective_daily_rate_eur,
    CASE
        WHEN a.daily_rate_override_eur IS NOT NULL THEN 'assignment_override'
        WHEN EXISTS (SELECT 1 FROM project_rate pr
                     WHERE pr.project_id = a.project_id
                       AND pr.profile = COALESCE(a.profile, rt.role_tier)
                       AND pr.valid_from <= a.start_date) THEN 'project_rate'
        WHEN EXISTS (SELECT 1 FROM framework_rate fr
                     WHERE fr.framework_id = p.framework_id
                       AND fr.profile = COALESCE(a.profile, rt.role_tier)
                       AND fr.valid_from <= a.start_date) THEN 'framework_rate'
        ELSE 'unset'
    END AS rate_source
FROM assignment a
JOIN project p   ON p.project_id   = a.project_id
JOIN customer c  ON c.customer_id  = p.customer_id
LEFT JOIN employee_role_tier rt ON rt.employee_id = a.employee_id;

-- --------------------------------------------------------------------------
-- assignment_monthly_margin: 20-working-day run-rate. Burden multiplier is
-- read from setting.burden_factor at query time. Fixed-price assignments
-- get NULL revenue/margin because revenue is project-level.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW assignment_monthly_margin AS
WITH burden AS (
    SELECT CAST(value AS double precision) AS factor
    FROM setting WHERE key = 'burden_factor'
),
entity_cost AS (
    SELECT a.assignment_id,
           CASE
               WHEN a.employee_id IS NOT NULL THEN
                   COALESCE(
                       CASE
                           WHEN ec.fix_salary IS NULL OR ec.fix_salary = 0 THEN NULL
                           WHEN ec.fix_salary_interval = 'yearly'  THEN ec.fix_salary / 12.0
                           WHEN ec.fix_salary_interval = 'monthly' THEN ec.fix_salary
                           ELSE NULL
                       END,
                       CASE
                           WHEN ec.hourly_salary IS NOT NULL AND ec.hourly_salary > 0
                            AND ec.weekly_working_hours IS NOT NULL AND ec.weekly_working_hours > 0
                           THEN ec.hourly_salary * ec.weekly_working_hours * (52.0 / 12.0)
                       END
                   ) * b.factor
               WHEN a.freelancer_id IS NOT NULL THEN
                   COALESCE(a.daily_cost_override_eur, f.daily_cost_eur) * 20
           END AS monthly_cost
    FROM assignment a
    CROSS JOIN burden b
    LEFT JOIN employee_current ec ON ec.employee_id  = a.employee_id
    LEFT JOIN freelancer        f ON f.freelancer_id = a.freelancer_id
)
SELECT
    aer.assignment_id,
    aer.employee_id,
    aer.freelancer_id,
    aer.is_external,
    aer.customer_name,
    aer.project_name,
    aer.billing_model,
    aer.effective_profile,
    aer.allocation_pct,
    aer.effective_daily_rate_eur,
    CAST(ec.monthly_cost AS numeric(12, 2)) AS entity_monthly_cost,
    CASE
        WHEN aer.billing_model = 'time_and_material' AND aer.effective_daily_rate_eur IS NOT NULL
        THEN CAST(aer.effective_daily_rate_eur * 20 * aer.allocation_pct
                  * COALESCE(ec_fte.fte, 1.0) AS numeric(12, 2))
    END AS monthly_revenue,
    CAST(ec.monthly_cost * aer.allocation_pct AS numeric(12, 2)) AS monthly_cost_allocated,
    CASE
        WHEN aer.billing_model = 'time_and_material' AND aer.effective_daily_rate_eur IS NOT NULL
        THEN CAST(
            aer.effective_daily_rate_eur * 20 * aer.allocation_pct * COALESCE(ec_fte.fte, 1.0)
            - ec.monthly_cost * aer.allocation_pct
            AS numeric(12, 2))
    END AS monthly_gross_margin,
    CASE
        WHEN aer.billing_model = 'time_and_material'
         AND aer.effective_daily_rate_eur IS NOT NULL
         AND aer.effective_daily_rate_eur > 0
         AND COALESCE(ec_fte.fte, 1.0) > 0
        THEN CAST(
            (aer.effective_daily_rate_eur * 20 * COALESCE(ec_fte.fte, 1.0) - ec.monthly_cost)
            * 100.0
            / (aer.effective_daily_rate_eur * 20 * COALESCE(ec_fte.fte, 1.0))
            AS numeric(5, 2))
    END AS gross_margin_pct
FROM assignment_effective_rate aer
LEFT JOIN entity_cost ec ON ec.assignment_id = aer.assignment_id
LEFT JOIN (
    SELECT employee_id,
           CASE WHEN weekly_working_hours IS NULL OR weekly_working_hours = 0 THEN NULL
                ELSE weekly_working_hours / 40.0
           END AS fte
    FROM employee_current
) ec_fte ON ec_fte.employee_id = aer.employee_id;

-- --------------------------------------------------------------------------
-- project_summary: today's headcount + monthly run-rate per project.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW project_summary AS
SELECT
    p.project_id,
    c.name AS customer,
    p.name AS project,
    p.billing_model,
    p.status,
    p.planned_start_date,
    p.planned_end_date,
    p.agreed_amount_eur,
    COUNT(DISTINCT amm.assignment_id) FILTER (
        WHERE amm.assignment_id IS NOT NULL
    ) AS n_current_assignments,
    COUNT(DISTINCT amm.employee_id) FILTER (
        WHERE amm.employee_id IS NOT NULL
    ) AS n_current_employees,
    COUNT(DISTINCT amm.freelancer_id) FILTER (
        WHERE amm.freelancer_id IS NOT NULL
    ) AS n_current_freelancers,
    CAST(SUM(amm.allocation_pct) AS numeric(8, 3)) AS total_allocation_now,
    CAST(SUM(amm.monthly_revenue) AS numeric(12, 2)) AS monthly_revenue_now,
    CAST(SUM(amm.monthly_cost_allocated) FILTER (
        WHERE NOT amm.is_external
    ) AS numeric(12, 2)) AS monthly_internal_cost_now,
    CAST(SUM(amm.monthly_cost_allocated) FILTER (
        WHERE amm.is_external
    ) AS numeric(12, 2)) AS monthly_external_cost_now,
    CAST(SUM(amm.monthly_cost_allocated) AS numeric(12, 2)) AS monthly_cost_now,
    CAST(SUM(amm.monthly_gross_margin) AS numeric(12, 2)) AS monthly_gross_margin_now
FROM project p
JOIN customer c ON c.customer_id = p.customer_id
LEFT JOIN assignment a ON a.project_id = p.project_id
                       AND a.start_date <= CURRENT_DATE
                       AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)
LEFT JOIN assignment_monthly_margin amm ON amm.assignment_id = a.assignment_id
GROUP BY p.project_id, c.name, p.name, p.billing_model, p.status,
         p.planned_start_date, p.planned_end_date, p.agreed_amount_eur;

-- --------------------------------------------------------------------------
-- employee_salary_normalized: convert fix_salary to monthly + FTE-adjusted.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW employee_salary_normalized AS
SELECT
    employee_id,
    first_name,
    last_name,
    email,
    status,
    department,
    position,
    weekly_working_hours,
    fix_salary,
    fix_salary_interval,
    hourly_salary,
    CASE
        WHEN fix_salary IS NULL OR fix_salary = 0 THEN NULL
        WHEN fix_salary_interval = 'yearly'  THEN CAST(fix_salary / 12 AS numeric(12, 2))
        WHEN fix_salary_interval = 'monthly' THEN fix_salary
        ELSE NULL
    END AS monthly_salary,
    CASE
        WHEN weekly_working_hours IS NULL OR weekly_working_hours = 0 THEN NULL
        ELSE CAST(weekly_working_hours / 40.0 AS numeric(5, 3))
    END AS fte,
    CASE
        WHEN fix_salary IS NULL OR fix_salary = 0 THEN NULL
        WHEN weekly_working_hours IS NULL OR weekly_working_hours = 0 THEN NULL
        WHEN fix_salary_interval = 'yearly'  THEN CAST((fix_salary / 12) / (weekly_working_hours / 40.0) AS numeric(12, 2))
        WHEN fix_salary_interval = 'monthly' THEN CAST(fix_salary / (weekly_working_hours / 40.0) AS numeric(12, 2))
        ELSE NULL
    END AS monthly_salary_fte
FROM employee_current;

-- --------------------------------------------------------------------------
-- employee_compensation: roll up compensation_event into per-employee totals.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW employee_compensation AS
WITH parts AS (
    SELECT
        employee_id,
        SUM(CASE
            WHEN category = 'FIXED_SALARY' AND interval = 'YEARLY'
                THEN amount_value / 12.0
            WHEN category = 'FIXED_SALARY' AND interval = 'MONTHLY'
                THEN amount_value
        END) AS monthly_fixed_eur,
        SUM(CASE
            WHEN category = 'RECURRING' AND interval = 'YEARLY'
                THEN amount_value / 12.0
            WHEN category = 'RECURRING' AND interval = 'MONTHLY'
                THEN amount_value
        END) AS monthly_recurring_raw_eur,
        SUM(CASE
            WHEN category = 'RECURRING'
              AND interval = 'YEARLY'
              AND COALESCE(type_name, '') NOT ILIKE '%Altersvorsorge%'
              AND COALESCE(type_name, '') NOT ILIKE '%Entgeltumwandlung%'
                THEN amount_value / 12.0
            WHEN category = 'RECURRING'
              AND interval = 'MONTHLY'
              AND COALESCE(type_name, '') NOT ILIKE '%Altersvorsorge%'
              AND COALESCE(type_name, '') NOT ILIKE '%Entgeltumwandlung%'
                THEN amount_value
        END) AS monthly_recurring_additive_eur,
        MAX(CASE WHEN category = 'HOURLY_SALARY' THEN amount_value END) AS hourly_rate_eur
    FROM compensation_event
    GROUP BY employee_id
)
SELECT
    ec.employee_id,
    ec.first_name,
    ec.last_name,
    ec.weekly_working_hours,
    CASE
        WHEN ec.weekly_working_hours IS NULL OR ec.weekly_working_hours = 0 THEN NULL
        ELSE CAST(ec.weekly_working_hours / 40.0 AS numeric(5, 3))
    END AS fte,
    CAST(p.monthly_fixed_eur AS numeric(12, 2)) AS monthly_fixed_eur,
    CAST(p.monthly_recurring_raw_eur AS numeric(12, 2)) AS monthly_recurring_raw_eur,
    CAST(p.monthly_recurring_additive_eur AS numeric(12, 2)) AS monthly_recurring_additive_eur,
    CASE
        WHEN p.hourly_rate_eur IS NOT NULL
         AND ec.weekly_working_hours IS NOT NULL
         AND ec.weekly_working_hours > 0
        THEN CAST(p.hourly_rate_eur * ec.weekly_working_hours * (52.0 / 12.0) AS numeric(12, 2))
    END AS monthly_hourly_eur,
    CAST(
        COALESCE(p.monthly_fixed_eur, 0)
        + COALESCE(p.monthly_recurring_additive_eur, 0)
        + COALESCE(
            CASE
                WHEN p.hourly_rate_eur IS NOT NULL
                 AND ec.weekly_working_hours IS NOT NULL
                 AND ec.weekly_working_hours > 0
                THEN p.hourly_rate_eur * ec.weekly_working_hours * (52.0 / 12.0)
            END, 0)
    AS numeric(12, 2)) AS monthly_total_eur,
    CASE
        WHEN ec.weekly_working_hours IS NOT NULL AND ec.weekly_working_hours > 0
        THEN CAST(
            (COALESCE(p.monthly_fixed_eur, 0)
             + COALESCE(p.monthly_recurring_additive_eur, 0)
             + COALESCE(
                CASE
                    WHEN p.hourly_rate_eur IS NOT NULL
                    THEN p.hourly_rate_eur * ec.weekly_working_hours * (52.0 / 12.0)
                END, 0))
            / (ec.weekly_working_hours / 40.0)
        AS numeric(12, 2))
    END AS monthly_total_fte_eur
FROM employee_current ec
LEFT JOIN parts p ON p.employee_id = ec.employee_id;

-- --------------------------------------------------------------------------
-- role_tier_band: IQR per role tier, active + non-multi-org + real only.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW role_tier_band AS
WITH base AS (
    SELECT rt.role_tier, esn.monthly_salary_fte
    FROM employee_current ec
    JOIN employee_role_tier rt ON rt.employee_id = ec.employee_id
    JOIN employee_salary_normalized esn ON esn.employee_id = ec.employee_id
    LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
    WHERE ec.status = 'active' AND esn.monthly_salary_fte IS NOT NULL
      AND COALESCE(a.is_multi_org, FALSE) = FALSE
      AND COALESCE(a.is_real_employee, TRUE) = TRUE
)
SELECT
    role_tier,
    COUNT(*) AS n,
    CAST(MIN(monthly_salary_fte) AS INTEGER) AS min,
    CAST(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS p25,
    CAST(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS median,
    CAST(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS p75,
    CAST(MAX(monthly_salary_fte) AS INTEGER) AS max
FROM base
GROUP BY role_tier;

-- --------------------------------------------------------------------------
-- gender_pay_gap_by_tier: median pay gap female vs male per role tier.
-- Disclosure guard: cells with n<3 emit NULL.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW gender_pay_gap_by_tier AS
WITH per_group AS (
    SELECT
        rt.role_tier AS tier,
        ec.gender,
        COUNT(*) AS n,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY esn.monthly_salary_fte) AS median
    FROM employee_current ec
    JOIN employee_salary_normalized esn ON esn.employee_id = ec.employee_id
    JOIN employee_annotation a ON a.employee_id = ec.employee_id
    JOIN employee_role_tier rt ON rt.employee_id = ec.employee_id
    WHERE ec.status = 'active'
      AND esn.monthly_salary_fte IS NOT NULL
      AND ec.gender IS NOT NULL
      AND COALESCE(a.is_multi_org, FALSE) = FALSE
      AND COALESCE(a.is_real_employee, TRUE) = TRUE
    GROUP BY rt.role_tier, ec.gender
)
SELECT
    tier,
    MAX(CASE WHEN gender='female' AND n >= 3 THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END)
              - MAX(CASE WHEN gender='female' AND n >= 3 THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' AND n >= 3 THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY tier
HAVING (MAX(CASE WHEN gender='female' AND n >= 3 THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END) IS NOT NULL);

-- --------------------------------------------------------------------------
-- gender_pay_gap_by_team: same shape but grouped by team_user.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW gender_pay_gap_by_team AS
WITH per_group AS (
    SELECT
        a.team_user AS team,
        ec.gender,
        COUNT(*) AS n,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY esn.monthly_salary_fte) AS median
    FROM employee_current ec
    JOIN employee_salary_normalized esn ON esn.employee_id = ec.employee_id
    JOIN employee_annotation a ON a.employee_id = ec.employee_id
    WHERE ec.status = 'active'
      AND esn.monthly_salary_fte IS NOT NULL
      AND ec.gender IS NOT NULL
      AND a.team_user IS NOT NULL
      AND COALESCE(a.is_multi_org, FALSE) = FALSE
    GROUP BY a.team_user, ec.gender
)
SELECT
    team,
    MAX(CASE WHEN gender='female' AND n >= 3 THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END)
              - MAX(CASE WHEN gender='female' AND n >= 3 THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' AND n >= 3 THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY team
HAVING (MAX(CASE WHEN gender='female' AND n >= 3 THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END) IS NOT NULL);

-- --------------------------------------------------------------------------
-- _total_ variants using employee_compensation.monthly_total_fte_eur.
-- --------------------------------------------------------------------------
--> statement-breakpoint
CREATE OR REPLACE VIEW gender_pay_gap_total_by_tier AS
WITH per_group AS (
    SELECT
        rt.role_tier AS tier,
        ec.gender,
        COUNT(*) AS n,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY comp.monthly_total_fte_eur) AS median
    FROM employee_current ec
    JOIN employee_compensation comp ON comp.employee_id = ec.employee_id
    JOIN employee_annotation a ON a.employee_id = ec.employee_id
    JOIN employee_role_tier rt ON rt.employee_id = ec.employee_id
    WHERE ec.status = 'active'
      AND comp.monthly_total_fte_eur IS NOT NULL
      AND ec.gender IS NOT NULL
      AND COALESCE(a.is_multi_org, FALSE) = FALSE
      AND COALESCE(a.is_real_employee, TRUE) = TRUE
    GROUP BY rt.role_tier, ec.gender
)
SELECT
    tier,
    MAX(CASE WHEN gender='female' AND n >= 3 THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male' AND n >= 3 THEN median END)
              - MAX(CASE WHEN gender='female' AND n >= 3 THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' AND n >= 3 THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY tier
HAVING (MAX(CASE WHEN gender='female' AND n >= 3 THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END) IS NOT NULL);
--> statement-breakpoint
CREATE OR REPLACE VIEW gender_pay_gap_total_by_team AS
WITH per_group AS (
    SELECT
        a.team_user AS team,
        ec.gender,
        COUNT(*) AS n,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY comp.monthly_total_fte_eur) AS median
    FROM employee_current ec
    JOIN employee_compensation comp ON comp.employee_id = ec.employee_id
    JOIN employee_annotation a ON a.employee_id = ec.employee_id
    WHERE ec.status = 'active'
      AND comp.monthly_total_fte_eur IS NOT NULL
      AND ec.gender IS NOT NULL
      AND a.team_user IS NOT NULL
      AND COALESCE(a.is_multi_org, FALSE) = FALSE
      AND COALESCE(a.is_real_employee, TRUE) = TRUE
    GROUP BY a.team_user, ec.gender
)
SELECT
    team,
    MAX(CASE WHEN gender='female' AND n >= 3 THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' AND n >= 3 THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   AND n >= 3 THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male' AND n >= 3 THEN median END)
              - MAX(CASE WHEN gender='female' AND n >= 3 THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' AND n >= 3 THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY team
HAVING (MAX(CASE WHEN gender='female' AND n >= 3 THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   AND n >= 3 THEN n END) IS NOT NULL);
