import { Container } from "@/components/layout/container";
import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() { return <Container className="pt-28"><Skeleton className="h-11 w-56" /><Skeleton className="mt-4 h-5 w-96 max-w-full" /><div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">{Array.from({length:12}).map((_,i)=><div key={i}><Skeleton className="aspect-[3/4]" /><Skeleton className="mt-3 h-4 w-4/5" /></div>)}</div></Container>; }
