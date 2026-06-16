-- The salary view is restricted to admin + manager. Those roles already
-- have full-org access to per-employee salary data (see employee detail,
-- inspect payload, salary trajectory). Suppressing aggregate gender
-- medians whenever a tier or team has fewer than 3 of a gender added no
-- protection beyond the role gate — it just hid the smallest cells from
-- the people who can already see the underlying rows.
--
-- Drop the `n >= 3` clauses from all four gender-gap views. Empty cells
-- (genuinely no employees of that gender in the group) are still NULL.
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
    MAX(CASE WHEN gender='female' THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male'   THEN median END)
              - MAX(CASE WHEN gender='female' THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY tier
HAVING (MAX(CASE WHEN gender='female' THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   THEN n END) IS NOT NULL);
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
    MAX(CASE WHEN gender='female' THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male'   THEN median END)
              - MAX(CASE WHEN gender='female' THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY team
HAVING (MAX(CASE WHEN gender='female' THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   THEN n END) IS NOT NULL);
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
    MAX(CASE WHEN gender='female' THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male' THEN median END)
              - MAX(CASE WHEN gender='female' THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY tier
HAVING (MAX(CASE WHEN gender='female' THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   THEN n END) IS NOT NULL);
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
    MAX(CASE WHEN gender='female' THEN n END)::INTEGER AS n_female,
    CAST(MAX(CASE WHEN gender='female' THEN median END) AS INTEGER) AS median_female,
    MAX(CASE WHEN gender='male'   THEN n END)::INTEGER AS n_male,
    CAST(MAX(CASE WHEN gender='male'   THEN median END) AS INTEGER) AS median_male,
    CAST(
      CASE WHEN MAX(CASE WHEN gender='female' THEN median END) IS NOT NULL
            AND MAX(CASE WHEN gender='male'   THEN median END) IS NOT NULL
        THEN (MAX(CASE WHEN gender='male' THEN median END)
              - MAX(CASE WHEN gender='female' THEN median END))
              * 100.0 / NULLIF(MAX(CASE WHEN gender='male' THEN median END), 0)
        ELSE NULL END AS numeric(5, 2)
    ) AS gap_pct_female_below_male
FROM per_group
GROUP BY team
HAVING (MAX(CASE WHEN gender='female' THEN n END) IS NOT NULL)
    OR (MAX(CASE WHEN gender='male'   THEN n END) IS NOT NULL);
