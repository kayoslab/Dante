"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, LockKeyhole, RotateCcw } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";

export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // ForbiddenError is thrown by requireSession({ minRole }) when a signed-in
  // user lacks the required role. Show a friendly 403 UI instead of the
  // generic crash card — usually hit by employees who bookmarked a
  // manager-only page.
  if (error.name === "ForbiddenError") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-amber-900">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1">
            <h2 className="text-base font-semibold">Access denied</h2>
            <p className="mt-1 text-sm">
              You don&rsquo;t have permission to view this page. If you think
              you should, ask your administrator.
            </p>
            <div className="mt-4">
              <Link
                href="/"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Back to Home
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-6 text-red-900">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="flex-1">
          <h2 className="text-base font-semibold">Something went wrong</h2>
          <p className="mt-1 text-sm">
            {error.message || "An unexpected error occurred while rendering this page."}
          </p>
          {error.digest && (
            <p className="mt-2 font-mono text-xs text-red-800/70">
              ref: {error.digest}
            </p>
          )}
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => unstable_retry()}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
