"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

import { useFreelancers, type FreelancerListItem } from "@/lib/api/freelancers";
import { formatRate } from "@/lib/format";

type Sort = "name" | "daily_cost_eur" | "active_assigns";
type Order = "asc" | "desc";

const COLUMNS: { key: Sort; label: string; align?: "right" }[] = [
  { key: "name", label: "Name" },
  { key: "daily_cost_eur", label: "Daily fee", align: "right" },
  { key: "active_assigns", label: "Active assigns", align: "right" },
];

function compare(a: FreelancerListItem, b: FreelancerListItem, sort: Sort): number {
  switch (sort) {
    case "name":
      return a.name.localeCompare(b.name);
    case "daily_cost_eur":
      return Number(a.daily_cost_eur) - Number(b.daily_cost_eur);
    case "active_assigns":
      return a.active_assigns - b.active_assigns;
  }
}

export function FreelancersTable() {
  const [sort, setSort] = useState<Sort>("name");
  const [order, setOrder] = useState<Order>("asc");
  const { data, isLoading, isError, error } = useFreelancers();

  const onHeaderClick = (key: Sort) => {
    if (sort === key) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(key);
      setOrder("asc");
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load: {error instanceof Error ? error.message : "unknown"}
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
        No freelancers yet. Click <strong>Add Freelancer</strong>.
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => {
    const cmp = compare(a, b, sort);
    return order === "asc" ? cmp : -cmp;
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map((c) => (
            <TableHead
              key={c.key}
              onClick={() => onHeaderClick(c.key)}
              className={`cursor-pointer select-none ${c.align === "right" ? "text-right" : ""}`}
            >
              <span className="inline-flex items-center gap-1">
                {c.label}
                {sort === c.key &&
                  (order === "asc" ? (
                    <ArrowUp className="h-3 w-3" />
                  ) : (
                    <ArrowDown className="h-3 w-3" />
                  ))}
              </span>
            </TableHead>
          ))}
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((f) => (
          <TableRow key={f.freelancer_id}>
            <TableCell>
              <Link
                href={`/freelancers/${f.freelancer_id}`}
                className="font-medium hover:underline"
              >
                {f.name}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatRate(f.daily_cost_eur)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {f.active_assigns}
            </TableCell>
            <TableCell>
              <Badge
                variant={f.status === "active" ? "secondary" : "outline"}
              >
                {f.status}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
