import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  BoardComment,
  BoardCommentThread,
  BoardIssueDetail,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessageSquareTextIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { RelativeTime } from "~/components/RelativeTime";
import { boardComment } from "~/state/board";
import { useQuietThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** The issue's comments with their replies, and a composer that posts to Linear as the user. */
export function BoardConversation(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issueId: string;
  readonly threadRef: ScopedThreadRef;
  readonly detail: BoardIssueDetail;
}) {
  const { detail } = props;
  const canComment = useAtomValue(boardComment.permissionAtom(props.environmentId));
  const send = useAtomCommand(boardComment, { reportFailure: false });
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<BoardCommentThread | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const linkedRef =
    detail.linkedThreadId === null
      ? null
      : scopeThreadRef(props.environmentId, detail.linkedThreadId);
  const linkedShell = useQuietThreadShell(linkedRef);

  const submit = async () => {
    const text = body.trim();
    if (text === "" || sending || !canComment) return;
    setSending(true);
    setProblem(null);
    const result = await send({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        issueId: props.issueId,
        body: text,
        ...(replyTo === null ? {} : { parentId: replyTo.id }),
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setProblem(failure instanceof Error ? failure.message : "Could not post the comment.");
      return;
    }
    setBody("");
    setReplyTo(null);
    if (linkedRef !== null && result.value.threadId === null) {
      setProblem("Posted to Linear, but it could not be sent to the thread.");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const reply = (thread: BoardCommentThread) => {
    setReplyTo(thread);
    textarea.current?.focus();
  };

  return (
    <section aria-label="Conversation" className="mt-4">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        <MessageSquareTextIcon />
        Conversation
        {detail.comments.length > 0 ? <span>{detail.comments.length}</span> : null}
      </h3>
      {detail.comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          {detail.comments.map((thread) => (
            <li key={thread.id} className="px-2.5 py-2">
              <CommentItem
                comment={thread}
                environmentId={props.environmentId}
                threadRef={props.threadRef}
              />
              {thread.replies.length > 0 ? (
                <ul className="mt-2 ml-1 space-y-2 border-l pl-3">
                  {thread.replies.map((replyComment) => (
                    <li key={replyComment.id}>
                      <CommentItem
                        comment={replyComment}
                        environmentId={props.environmentId}
                        threadRef={props.threadRef}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-1">
                <Button
                  size="micro"
                  variant="ghost-muted"
                  disabled={!canComment}
                  aria-label={`Reply to ${thread.author}`}
                  onClick={() => reply(thread)}
                >
                  Reply
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 flex flex-col gap-1.5">
        {replyTo !== null ? (
          <div className="flex">
            <Badge variant="secondary">
              Replying to {replyTo.author}
              <Button
                size="icon-tiny"
                variant="ghost-muted"
                aria-label={`Stop replying to ${replyTo.author}`}
                onClick={() => setReplyTo(null)}
              >
                <XIcon />
              </Button>
            </Badge>
          </div>
        ) : null}
        <Textarea
          ref={textarea}
          size="sm"
          rows={2}
          value={body}
          disabled={!canComment}
          placeholder={replyTo === null ? "Comment on the issue" : `Reply to ${replyTo.author}`}
          aria-label={replyTo === null ? "Comment" : `Reply to ${replyTo.author}`}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {problem !== null ? <p className="text-xs text-destructive">{problem}</p> : null}
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-2xs leading-5 text-muted-foreground">
            {linkedRef === null ? (
              "No thread linked. This goes to Linear only."
            ) : (
              <>
                {"Also sends to: "}
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: linkedRef.environmentId, threadId: linkedRef.threadId }}
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  {linkedShell?.title.trim() || "Thread"}
                </Link>
              </>
            )}
          </p>
          <Button
            size="xs"
            disabled={!canComment || sending || body.trim() === ""}
            onClick={() => void submit()}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function CommentItem(props: {
  readonly comment: BoardComment;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
}) {
  const { comment } = props;
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="truncate font-medium">{comment.author}</span>
        {comment.agent ? (
          <Badge size="sm" variant="info">
            agent
          </Badge>
        ) : null}
        <span className="shrink-0 text-muted-foreground">
          <RelativeTime timestamp={comment.createdAt} />
        </span>
      </div>
      <div className="mt-0.5 text-sm">
        <ChatMarkdown
          text={comment.body}
          cwd={undefined}
          environmentId={props.environmentId}
          threadRef={props.threadRef}
        />
      </div>
    </>
  );
}
