import { createFileRoute } from "@tanstack/react-router";

import { TeamProjectsPage } from "../components/teamProjects/TeamProjectsPage";

export const Route = createFileRoute("/_chat/team-projects")({
  component: TeamProjectsPage,
});
