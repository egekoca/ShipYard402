import { RunDetail } from '../../../components/run-detail';
import { parseApiBackend } from '../../../lib/api-backends';

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ backend?: string }>;
}) {
  const { runId } = await params;
  const { backend } = await searchParams;
  return <RunDetail runId={runId} apiBackend={parseApiBackend(backend)} />;
}
