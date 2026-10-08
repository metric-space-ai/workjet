import type { CSSProperties, ReactNode } from "react";

import "./WorkjetModesIntro.css";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const DEV_DESCRIPTION =
  "Describe what you want to build. Coding agents write, test and review the code in your projects, and you follow each change as it happens.";
const OPS_DESCRIPTION =
  "Automations, processes and specialized apps keep a business running. Ops shows what they are doing and lets you step in when something needs you.";
const CTOX_DESCRIPTION =
  "The engine under both modes. It runs the agents, schedules and projects, so Dev and Ops work from the same foundation.";

/** Staggers a one-shot entrance. The value is a CSS delay, not a runtime timer. */
function delay(ms: number): CSSProperties {
  return { "--wmi-delay": `${ms}ms` } as CSSProperties;
}

function FrameBackdrop() {
  return (
    <>
      <rect
        x="4"
        y="4"
        width="232"
        height="142"
        rx="10"
        fill="currentColor"
        fillOpacity="0.03"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <circle cx="16" cy="16" r="2.5" fill="currentColor" fillOpacity="0.3" />
      <circle cx="26" cy="16" r="2.5" fill="currentColor" fillOpacity="0.3" />
      <circle cx="36" cy="16" r="2.5" fill="currentColor" fillOpacity="0.3" />
    </>
  );
}

/** The Dev surface: a project sidebar, code being written, and a prompt line. */
function DevPictogram() {
  const codeLines = [
    { y: 38, width: 120, accent: true },
    { y: 54, width: 90, accent: false },
    { y: 70, width: 105, accent: false },
    { y: 86, width: 70, accent: false },
    { y: 102, width: 112, accent: false },
  ];
  return (
    <svg aria-hidden="true" className="h-auto w-full text-foreground" viewBox="0 0 240 150">
      <FrameBackdrop />
      <rect x="12" y="28" width="52" height="112" rx="4" fill="currentColor" fillOpacity="0.06" />
      {[0, 1, 2, 3].map((index) => (
        <rect
          key={index}
          x="18"
          y={36 + index * 14}
          width="34"
          height="6"
          rx="3"
          fill={index === 0 ? "var(--primary)" : "currentColor"}
          fillOpacity={index === 0 ? "1" : "0.3"}
        />
      ))}
      {codeLines.map((line, index) => (
        <rect
          key={line.y}
          className="wmi-grow"
          style={delay(120 + index * 110)}
          x="74"
          y={line.y}
          width={line.width}
          height="6"
          rx="3"
          fill={line.accent ? "var(--primary)" : "currentColor"}
          fillOpacity={line.accent ? "1" : "0.42"}
        />
      ))}
      <rect
        className="wmi-rise"
        style={delay(700)}
        x="74"
        y="120"
        width="150"
        height="18"
        rx="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.4"
      />
      <circle
        className="wmi-rise"
        style={delay(800)}
        cx="212"
        cy="129"
        r="6"
        fill="var(--primary)"
      />
    </svg>
  );
}

/** The Ops surface: KPI tiles, a trend line, and a list of running work. */
function OpsPictogram() {
  const statusRows = [
    { y: 106, active: true },
    { y: 120, active: false },
    { y: 134, active: false },
  ];
  return (
    <svg aria-hidden="true" className="h-auto w-full text-foreground" viewBox="0 0 240 150">
      <FrameBackdrop />
      {[14, 88, 162].map((x, index) => (
        <g key={x}>
          <rect x={x} y="18" width="66" height="34" rx="6" fill="currentColor" fillOpacity="0.07" />
          <rect
            className="wmi-grow"
            style={delay(100 + index * 90)}
            x={x + 8}
            y="42"
            width="34"
            height="4"
            rx="2"
            fill="currentColor"
            fillOpacity="0.45"
          />
        </g>
      ))}
      <path
        className="wmi-draw"
        style={{ ...delay(350), "--wmi-length": "1" } as CSSProperties}
        d="M14 84 L50 74 L86 80 L122 60 L158 66 L192 46 L226 40"
        fill="none"
        pathLength={1}
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {statusRows.map((row, index) => (
        <g key={row.y} className="wmi-rise" style={delay(700 + index * 120)}>
          <circle
            cx="22"
            cy={row.y + 4}
            r="3.5"
            fill={row.active ? "var(--primary)" : "currentColor"}
            fillOpacity={row.active ? "1" : "0.5"}
          />
          <rect
            x="32"
            y={row.y}
            width="190"
            height="8"
            rx="4"
            fill="currentColor"
            fillOpacity="0.14"
          />
        </g>
      ))}
    </svg>
  );
}

/** Two rails that carry both modes down into the shared engine. */
function EngineLinks() {
  return (
    <svg
      aria-hidden="true"
      className="h-6 w-full text-foreground"
      preserveAspectRatio="none"
      viewBox="0 0 100 24"
    >
      {[25, 75].map((x) => (
        <line
          key={x}
          className="wmi-link"
          style={delay(900)}
          x1={x}
          x2={x}
          y1="0"
          y2="24"
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function ModeCard(props: {
  readonly label: string;
  readonly tagline: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const headingId = `workjet-mode-${props.label.toLowerCase()}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      {props.children}
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="text-base font-semibold text-foreground">
          {props.label}
        </h3>
        <p className="text-sm font-medium text-foreground">{props.tagline}</p>
        <p className="text-sm text-muted-foreground">{props.description}</p>
      </div>
    </section>
  );
}

export function WorkjetModesIntroDialog(props: {
  readonly open: boolean;
  readonly onDismiss: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) props.onDismiss();
      }}
    >
      <DialogPopup data-workjet-modes-intro="">
        <DialogPanel>
          <DialogHeader>
            <DialogTitle>Two ways to work with Workjet</DialogTitle>
            <DialogDescription>
              Dev and Ops share one engine. Start on the side that matches your work. The switch in
              the header moves you between them at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <ModeCard
              label="Dev"
              tagline="Build applications with AI"
              description={DEV_DESCRIPTION}
            >
              <DevPictogram />
            </ModeCard>
            <ModeCard
              label="Ops"
              tagline="Run the businesses you build"
              description={OPS_DESCRIPTION}
            >
              <OpsPictogram />
            </ModeCard>
          </div>
          <div className="flex flex-col gap-1 pt-1">
            <EngineLinks />
            <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted/40 px-4 py-3 text-center">
              <span className="text-sm font-semibold tracking-wide text-foreground">CTOX</span>
              <p className="text-sm text-muted-foreground">{CTOX_DESCRIPTION}</p>
            </div>
          </div>
          <DialogFooter>
            <p className="mr-auto text-xs text-muted-foreground">
              You can open this introduction again under Settings, General.
            </p>
            <Button variant="ghost" onClick={props.onDismiss}>
              Skip
            </Button>
            <Button onClick={props.onDismiss}>Continue</Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
