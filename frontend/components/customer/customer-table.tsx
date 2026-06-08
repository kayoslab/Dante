"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useCustomers } from "@/lib/api/customers";

type Sort = "name" | "n_projects" | "n_frameworks" | "customer_id";
type Order = "asc" | "desc";

const COLUMNS: { key: Sort; label: string; align?: "right" }[] = [
  { key: "name", label: "Name" },
  { key: "n_frameworks", label: "Frameworks", align: "right" },
  { key: "n_projects", label: "Projects", align: "right" },
];

export function CustomerTable() {
  const [sort, setSort] = useState<Sort>("name");
  const [order, setOrder] = useState<Order>("asc");
  const { data, isLoading, isError, error } = useCustomers(sort, order);

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
        Failed to load: {error instanceof Error ? error.message : "unknown error"}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
        No customers yet. Click <strong>Add Customer</strong> to create one.
      </div>
    );
  }

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
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((c) => (
          <TableRow key={c.customer_id}>
            <TableCell>
              <Link
                href={`/customers/${c.customer_id}`}
                className="font-medium hover:underline"
              >
                {c.name}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {c.n_frameworks}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {c.n_projects}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
