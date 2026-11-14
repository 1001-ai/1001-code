---
name: ask-the-user
description: Ask the user a decision question they can answer inline in the chat, with a fenced `question` block in a normal reply. Use when you need the user to choose between options, confirm a yes/no decision, or give a short answer before you continue.
---

# Ask the user

The web and desktop clients render a fenced `question` block in your reply as a card with buttons and a text field. Clicking an option or entering text writes a line `<id>: <answer>` into the user's draft. Nothing is sent until the user sends the message, so they can answer several questions, add comments and edit the draft first. The card shows as answered once a later user message has a line starting `<id>:`.

## When to ask

- Ask only for decisions the user must make: a trade-off with no clear winner, a scope choice, a destructive or costly step, or facts only they know.
- Do not ask about what you can find out yourself, or about what the instructions already settle. Decide, and say what you decided.
- Ask at most 4 questions in one message. Put them at the end of the reply, after the context the user needs to answer.
- Keep working on what does not depend on the answer, and say what you are waiting on.

## The format

````markdown
```question
{"id":"Q1","prompt":"Keep the old endpoint for one release?","kind":"boolean","recommended":"Yes"}
```
````

The body is one JSON object with exactly these keys:

| Key           | Required                      | Rules                                                                                                 |
| ------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`          | yes                           | A letter, then up to 23 letters, digits, `_` or `-`. Case-sensitive.                                  |
| `prompt`      | yes                           | One line of plain text, at most 500 characters. No markdown.                                          |
| `kind`        | yes                           | `choice` (pick one), `multi` (pick any), `boolean` (Yes/No) or `text` (free text).                    |
| `options`     | for `choice` and `multi` only | 2 to 8 distinct one-line strings, each at most 120 characters. Leave it out for `boolean` and `text`. |
| `recommended` | no                            | One of the options, or `Yes`/`No` for `boolean`. Not allowed for `text`.                              |

Every card also has a free-text field, so a user can answer a `choice` in their own words.

A block that breaks a rule renders as an ordinary code block, and the user gets no controls. Unknown keys, line breaks, invisible characters, leading or trailing spaces, and a `recommended` that is not an option all break it.

## Ids and answers

- Number questions `Q1`, `Q2` and up through the thread. Never reuse an id for a different question.
- To ask the same question again, keep its id. The user's newest `<id>:` line is the answer.
- Answers arrive as lines in the user's message: `Q1: Yes`. A `multi` answer lists options separated by `, `. Any other text is the user's own words.
- Read the whole message, not only the answer lines. The user may have added comments.

## Example

````markdown
Two things need your call before I wire up the export.

```question
{"id":"Q3","prompt":"Which formats should the export offer?","kind":"multi","options":["CSV","JSON","Parquet"],"recommended":"CSV"}
```

```question
{"id":"Q4","prompt":"What should the default file name be?","kind":"text"}
```
````

The mobile app shows the block as plain code. A user there answers by typing `Q3: CSV, JSON` in their reply.
