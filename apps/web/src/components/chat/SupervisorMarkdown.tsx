import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

/** Public model text uses chat typography without interpreting embedded HTML. */
export function SupervisorMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="chat-markdown w-full min-w-0 break-words text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown remarkPlugins={plugins}>{text}</ReactMarkdown>
    </div>
  );
}
