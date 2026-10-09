import { useEffect, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { Button } from "./ui/button";

export interface JourFixePlayerProps {
  readonly source?: string | undefined;
  readonly rate?: number | undefined;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  /** Show mode: play each slide's narration and go to the next slide when it ends. */
  readonly autoAdvance?: boolean;
  readonly onAutoAdvanceChange?: (autoAdvance: boolean) => void;
  /** Lets the meeting's Space key start and pause the narration. */
  readonly controlRef?: { current: (() => void) | null };
  readonly onFullscreen?: () => void;
}

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** The parent only supplies a blob from the authorized instance file channel. */
export function JourFixePlayer(props: JourFixePlayerProps) {
  return <PlayerContent key={props.source ?? "unavailable"} {...props} />;
}

function PlayerContent({
  source,
  rate = 1.15,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  autoAdvance = false,
  onAutoAdvanceChange,
  controlRef,
  onFullscreen,
}: JourFixePlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(rate);
  const [failed, setFailed] = useState(false);
  const playable = source?.startsWith("blob:") === true && !failed;
  useEffect(() => {
    if (audio.current) {
      audio.current.preservesPitch = true;
      audio.current.playbackRate = speed;
    }
  }, [speed]);
  useEffect(() => {
    const element = audio.current;
    return () => element?.pause();
  }, [source]);
  useEffect(() => {
    // Show mode starts the narration as soon as the slide's audio is there.
    if (!autoAdvance || !playable) return;
    audio.current?.play().catch(() => setPlaying(false));
  }, [autoAdvance, playable]);
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = () => void togglePlayback();
    return () => {
      controlRef.current = null;
    };
  });
  async function togglePlayback() {
    if (!audio.current || !playable) return;
    if (!audio.current.paused) {
      audio.current.pause();
      return;
    }
    try {
      await audio.current.play();
    } catch {
      setFailed(true);
    }
  }
  function changeSlide(action: () => void) {
    audio.current?.pause();
    action();
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Slide player">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Previous slide"
          disabled={!hasPrevious}
          onClick={() => changeSlide(onPrevious)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label={playing ? "Pause narration" : "Play narration"}
          disabled={!playable}
          onClick={() => void togglePlayback()}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Next slide"
          disabled={!hasNext}
          onClick={() => changeSlide(onNext)}
        >
          <ChevronRightIcon />
        </Button>
        <input
          type="range"
          aria-label="Narration progress"
          min={0}
          max={duration || 1}
          step={0.1}
          value={position}
          disabled={!playable || duration === 0}
          className="min-w-16 flex-1 accent-primary"
          onChange={(event) => {
            if (!audio.current) return;
            const time = Number(event.target.value);
            audio.current.currentTime = time;
            setPosition(time);
          }}
        />
        <span className="text-xs tabular-nums text-muted-foreground">
          {timestamp(position)} / {timestamp(duration)}
        </span>
        <select
          aria-label="Playback speed"
          value={speed}
          disabled={!playable}
          className="h-7 rounded-full border border-border bg-background px-2 text-xs"
          onChange={(event) => {
            const rate = Number(event.target.value);
            if (audio.current) {
              audio.current.preservesPitch = true;
              audio.current.playbackRate = rate;
            }
            setSpeed(rate);
          }}
        >
          {[...new Set([0.8, 1, 1.15, 1.25, 1.5, rate])].sort((a, b) => a - b).map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
        {onAutoAdvanceChange && (
          <Button
            size="sm"
            variant={autoAdvance ? "default" : "outline"}
            aria-pressed={autoAdvance}
            title="Play each slide's narration and go to the next slide when it ends"
            onClick={() => onAutoAdvanceChange(!autoAdvance)}
          >
            Auto
          </Button>
        )}
        {onFullscreen && (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Present full screen"
            title="Full screen (F) · slides ← → · narration Space"
            onClick={onFullscreen}
          >
            <Maximize2Icon />
          </Button>
        )}
        {playable && (
          <audio
            ref={audio}
            preload="metadata"
            src={source}
            onLoadedMetadata={(event) => {
              event.currentTarget.preservesPitch = true;
              event.currentTarget.playbackRate = speed;
              const value = event.currentTarget.duration;
              setDuration(Number.isFinite(value) ? value : 0);
            }}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              if (autoAdvance && hasNext) changeSlide(onNext);
            }}
            onError={() => {
              setPlaying(false);
              setFailed(true);
            }}
          />
        )}
      </div>
      {!playable && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {failed ? "Narration could not be played." : "Narration is not available yet."}
        </p>
      )}
    </div>
  );
}
