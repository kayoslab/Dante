"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
          color: "#7f1d1d",
          background: "#fef2f2",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          The app crashed
        </h1>
        <p style={{ marginTop: "0.5rem" }}>
          {error.message || "An unexpected error occurred in the root layout."}
        </p>
        {error.digest && (
          <p style={{ marginTop: "0.5rem", fontFamily: "monospace", fontSize: "0.8rem" }}>
            ref: {error.digest}
          </p>
        )}
        <button
          onClick={() => unstable_retry()}
          style={{
            marginTop: "1rem",
            border: "1px solid #b91c1c",
            background: "white",
            padding: "0.4rem 0.8rem",
            borderRadius: "0.375rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
