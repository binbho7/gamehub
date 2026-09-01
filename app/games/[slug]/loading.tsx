import { Container } from "@/components/layout/container";
import { Skeleton } from "@/components/ui/skeleton";

export default function GameDetailLoading() {
  return <><Skeleton className="h-[570px] rounded-none" /><Container className="grid gap-12 pt-12 lg:grid-cols-[minmax(0,1fr)_320px]"><div className="flex flex-col gap-8"><Skeleton className="h-8 w-40" /><div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-32" /><Skeleton className="h-32" /></div><Skeleton className="h-8 w-48" /><Skeleton className="aspect-video" /></div><Skeleton className="h-96" /></Container></>;
}
