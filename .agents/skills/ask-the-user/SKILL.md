---
name: ask-the-user
description: Ask the user a decision question they can answer inline in the chat, with a question blockquote in a normal reply. Use when you need the user to choose between options, confirm a yes/no decision, or give a short answer before you continue.
---

# Ask the user

Write each question as a short blockquote in your reply. It reads as plain markdown in every client, and the web and desktop clients turn it into a card with options and a text field. Choosing an option or entering text writes a line `<id>: <answer>` into the user's draft. Nothing is sent until the user sends the message, so they can answer several questions, add comments and edit the draft first. In other clients the user types the same line. The card shows as answered once a later user message has a line starting `<id>:`.

## When to ask

- Ask only for decisions the user must make: a trade-off with no clear winner, a scope choice, a destructive or costly step, or facts only they know.
- Do not ask about what you can find out yourself, or about what the instructions already settle. Decide, and say what you decided.
- Ask at most 4 questions in one message. Put them at the end of the reply, after the context the user needs to answer.
- Keep working on what does not depend on the answer, and say what you are waiting on.

## The format

```markdown
> **Q1 · Which name should the config file have?**
>
> - app.config.json _(recommended)_
> - settings.json
```

- **First line:** `> **<id> · <prompt>**`, all in bold. The id is `Q` and a number. The separator is a space, a middle dot `·`, and a space. The prompt is one line of plain text, at most 500 characters, with no markdown.
- **Pick one:** 2 to 8 lines `> - <option>`, each one line of plain text, at most 120 characters, all different.
- **Pick any:** the same list, with ` (pick any)` at the end of the prompt, inside the bold. An option must not contain `, `.
- **Yes or no:** exactly two options, `Yes` then `No`.
- **Free text:** no list. One line `> _Reply with <id>: <what to write>._`
- **Recommended:** end at most one option with ` _(recommended)_`.

Put a blank line between two questions, and between a question and the text after it.

Every card also has a free-text field, so a user can answer a choice in their own words.

A quote that breaks a rule renders as an ordinary quote, and the user gets no card. Extra lines, nested or numbered lists, `*` bullets, wrapped items, other markdown in the prompt or options, invisible characters, and two recommendations all break it.

## Ids and answers

- Number questions `Q1`, `Q2` and up through the thread. Never reuse an id for a different question.
- To ask the same question again, keep its id. The user's newest `<id>:` line is the answer.
- Answers arrive as lines in the user's message: `Q1: Yes`. A pick-any answer lists options separated by `, `. Any other text is the user's own words.
- Read the whole message, not only the answer lines. The user may have added comments.

## Example

```markdown
Three things need your call before I wire up the export.

> **Q3 · Which formats should the export offer? (pick any)**
>
> - CSV _(recommended)_
> - JSON
> - Parquet

> **Q4 · Keep the old endpoint for one release?**
>
> - Yes _(recommended)_
> - No

> **Q5 · What should the default file name be?**
> _Reply with Q5: the file name._
```
