import { createFileRoute } from '@tanstack/react-router';
import { TeamDetail } from '@/components/teams/team-detail';

export const Route = createFileRoute('/teams/$teamId')({
  component: TeamDetailPage,
});

function TeamDetailPage() {
  const { teamId } = Route.useParams();
  return <TeamDetail teamId={teamId} />;
}
