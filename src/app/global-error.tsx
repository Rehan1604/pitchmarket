"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-GB">
      <body style={{ background: "#08130f", color: "#f1eee4", fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 28 }}>PITCHMARKET is having trouble</h1>
          <p style={{ color: "#82918a" }}>Your portfolio and trades are safe. Try again in a moment.</p>
          <button onClick={reset} style={{ marginTop: 16, background: "#d4f55c", color: "#050d0a", border: 0, borderRadius: 6, padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
