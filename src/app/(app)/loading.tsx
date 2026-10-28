import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="mb-6 h-12 w-64" />
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
