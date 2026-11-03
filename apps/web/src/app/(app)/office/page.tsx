import Office from '@/features/office/Office';
export default async function Page({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
 const { source } = await searchParams;
 return <Office mode={source === 'github' ? 'github' : 'demo'} />;
}
