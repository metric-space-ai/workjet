import { memo } from "react";

/** Plan fertig: der Planname ist der Titel, ohne Status-Badge (Owner-Regel). */
export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-4 py-3 sm:px-5">
      <span className="block min-w-0 truncate text-[13.5px] font-medium">
        {planTitle ?? "Plan"}
      </span>
    </div>
  );
});
