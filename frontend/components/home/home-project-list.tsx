"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { ProjectTable } from "@/components/portfolio/portfolio-project-table";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHomeProjects } from "@/lib/api/home";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";

/** Lean Home project list shared by manager/admin (all projects) and
 * SDM employee (only granted projects) scopes. The endpoint decides
 * scope from the session — this component only renders rows and the
 * month nav. Drops every KPI grid + bench section that used to live on
 * Home; those have moved to `/reports/portfolio-rentability`. */
export function HomeProjectList({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  const todayMonth = isoMonthOf(new Date());
  const [month, setMonth] = useState<string>(() => todayMonth);
  const { data, isLoading, isError, error } = useHomeProjects(month);
  const isFuture = month > todayMonth;

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>{title}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMonth(todayMonth)}
              disabled={month === todayMonth}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMonth(shiftMonth(month, +1))}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="text-sm font-medium text-foreground">
          {monthLabel(month)}
          {isFuture && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              (forecast)
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        )}
        {data && data.projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No projects with active assignments in this month.
          </p>
        )}
        {data && data.projects.length > 0 && (
          <ProjectTable rows={data.projects} />
        )}
      </CardContent>
    </Card>
  );
}
