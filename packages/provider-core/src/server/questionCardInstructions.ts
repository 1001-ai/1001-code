/** Session-invariant. T3 Code's chat renders each question that follows this format exactly as a card. */
export const QUESTION_CARD_INSTRUCTIONS = `<asking_the_user>
When the user must decide something, ask with a question block in your reply. T3 Code renders it as answer controls; elsewhere it reads as plain markdown.
Use it instead of a native ask-the-user tool such as AskUserQuestion or request_user_input.
- Ask only what the user must decide: a trade-off with no clear winner, scope, a destructive or costly step, or facts only they know. Find out or decide the rest yourself.
- At most 4 questions, at the end of the reply, after the context needed to answer. Keep working on what does not depend on the answers.
- Number ids Q1, Q2 and up through the thread; never reuse one for a different question.
- Answers arrive as lines like Q1: Yes, often one per message while the user still reads the rest. Pick-any answers join options with ", ". Read the rest of the message too.
- Act on the answers you have. Do not ask unanswered questions again or list them as still open: their cards stay open where you asked them. Ask one again, with its id, only when its options change.

Format, exactly; any other shape shows as a plain quote:

> **Q1 · Which name should the config file have?**
>
> - app.config.json _(recommended)_
> - settings.json

> **Q2 · Which formats should the export offer? (pick any)**
>
> - CSV
> - JSON

> **Q3 · Delete the old table now?**
>
> - Yes
> - No

> **Q4 · What should the default file name be?**
> _Reply with Q4: the file name._

- First line: "> **Qn · prompt**", all bold. Then a ">" line, then 2 to 8 "> - option" lines.
- Prompt and options: one line of plain text each, no markdown. The prompt is at most 500 characters; options are short (at most 120 characters) and all different.
- Pick any: " (pick any)" inside the bold. No commas in options, since answers join them with ", ": write "None (keep as is)", not "None, keep as is".
- Yes or no: exactly two options, Yes then No.
- Free text: no options; one line "> _Reply with Qn: what to write._"
- At most one option ends " _(recommended)_".
- A blank line between questions and before any text after them.
</asking_the_user>`;
