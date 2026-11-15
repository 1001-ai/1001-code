# Questions

The Questions page lists everything an agent is waiting on you for, across every thread in every
connected environment: question cards it asked in a reply, the agent's own questions, and tool
approvals. Open it from the sidebar, the command palette ("Open questions"), or `mod+shift+u` on
web and desktop. On Linux, input methods such as IBus take Ctrl+Shift+U for Unicode entry; rebind
`questions.open` in your keybindings if the shortcut does nothing there. Each thread shows its project, environment and how long it has waited; **Open
thread** jumps to the first question.

Answer question cards right on the page. Your picks go into that thread's draft, the same as
picking them in the thread, and **Send answers** sends one message with just the `Q4: answer`
lines, using the thread's current model. The rest of your draft stays. If the agent is still
working, the message reaches it the way a normal send would. Approvals and the agent's own
questions work as they do above the composer; a question that needs a typed answer opens in the
thread. A few requests, such as a link or a secret the agent asks for, show only as a pointer to
the thread.

A thread leaves the list once you reply to it in any way, so answer every question you want to
answer in the same message. Archived threads and threads your tag filter hides are not listed.
The mobile app does not have this page.
