import { createContext } from "react";

/**
 * The assistant item whose markdown is rendering. Set only where the reader can answer in the
 * thread's composer; without it a question renders as an ordinary quote or code block.
 */
export const QuestionAskedInItemContext = createContext<string | null>(null);

/**
 * Sends an answer as the thread's next message, with anything else in its draft, and says whether
 * the composer took it. Null where an answer can only go into the draft.
 */
export const QuestionAnswerSendContext = createContext<
  ((questionId: string, answer: string) => boolean) | null
>(null);
