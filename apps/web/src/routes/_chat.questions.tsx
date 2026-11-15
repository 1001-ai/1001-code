import { createFileRoute } from "@tanstack/react-router";

import { QuestionsPage } from "../components/questions/QuestionsPage";

export const Route = createFileRoute("/_chat/questions")({
  component: QuestionsPage,
});
