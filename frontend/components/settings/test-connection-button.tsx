"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, PlugZapIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  testIntegrationConnectionAction,
  type TestConnectionSuccess,
} from "@/lib/actions/integrations";

export function TestConnectionButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestConnectionSuccess | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const r = await testIntegrationConnectionAction(slug);
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      setResult(r.data);
      if (r.data.ok) toast.success(`Connection OK (${r.data.duration_ms} ms)`);
      else toast.error("Connection failed");
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={run} disabled={running}>
        {running ? <Loader2Icon className="size-4 animate-spin" /> : <PlugZapIcon className="size-4" />}
        Test connection
      </Button>
      {result && !running && (
        <p
          className={
            result.ok ? "text-xs text-green-700" : "whitespace-pre-wrap font-mono text-xs text-red-700"
          }
        >
          {result.ok ? `OK · ${result.duration_ms} ms` : result.detail}
        </p>
      )}
    </div>
  );
}
