# Questions

The Questions page lists everything an agent is waiting on you for, across every thread in every
connected environment: question cards it asked in a reply, the agent's own questions, tool
approvals, and memories it proposed that you have not accepted or rejected yet. Open it from the sidebar, the command palette ("Open questions"), or `mod+shift+u` on
web and desktop. On Linux, input methods such as IBus take Ctrl+Shift+U for Unicode entry; rebind
`questions.open` in your keybindings if the shortcut does nothing there. Each thread shows its project, environment and how long it has waited; **Open
thread** jumps to the first question.

Answer question cards right on the page. Your picks go into that thread's draft, the same as
picking them in the thread, and **Send answers** sends one message with just the `Q4: answer`
lines, using the thread's current model. The rest of your draft stays. If the agent is still
working, the message reaches it the way a normal send would. Approvals and the agent's own
questions work as they do above the composer; a question that needs a typed answer opens in the
thread. A few requests, such as a link or a secret the agent asks for, show only as a pointer to
the thread. Memory proposals have the same Accept and Reject buttons as in the Memory panel, and
count as waiting until you answer them.

The filter in the header narrows the list to Questions, Approvals or Memories, and the project
menu beside it to one project with something waiting.

To decline a question card, click **Skip** on it, here or in the thread. It answers `Q4: skipped`,
and the agent stops the work that depends on that question instead of choosing for you, then says
what it left undone.

When something you wrote later makes one of the agent's open question cards pointless, the agent
can withdraw it with a `Q4: no longer needed` line. The card then reads "No longer needed" and
leaves this page; you can still answer it if you want to.

A question card stays on the list until you answer or skip it, even after you reply to the
thread about something else, so you can answer cards one at a time. Archived threads and threads your tag filter hides are not listed.
The mobile app does not have this page.
