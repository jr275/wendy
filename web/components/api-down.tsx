import { API_DOWN_BODY, API_DOWN_TITLE } from "@/lib/apiState";

/** Shown when Wendy's read API could not be reached. It says so plainly and claims nothing about the data. */
export function ApiDown() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <div className="card px-6 py-10 text-center" role="status">
        <p className="font-semibold">{API_DOWN_TITLE}</p>
        <p className="mt-1 text-sm text-muted">{API_DOWN_BODY}</p>
      </div>
    </main>
  );
}
