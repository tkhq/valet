import { createFileRoute } from '@tanstack/react-router';
import { TeamList } from '@/components/teams/team-list';

export const Route = createFileRoute('/teams/')({
  component: TeamList,
});
