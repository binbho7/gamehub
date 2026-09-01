import { Container } from "@/components/layout/container";
import { Skeleton } from "@/components/ui/skeleton";

export default function GamesLoading() {
  return <Container className="pt-28"><Skeleton className="h-11 w-48" /><Skeleton className="mt-4 h-5 w-80 max-w-full" /><Skeleton className="mt-10 h-12 w-full" /><div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-11" />)}</div><div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 12 }).map((_, index) => <div key={index}><Skeleton className="aspect-[3/4]" /><Skeleton className="mt-3 h-4 w-4/5" /></div>)}</div></Container>;
}
