import { createContext } from "react";

/**
 * The assistant item whose markdown is rendering. Set only where the reader can answer in the
 * thread's composer; without it a question renders as an ordinary quote or code block.
 */
export const QuestionAskedInItemContext = createContext<string | null>(null);
