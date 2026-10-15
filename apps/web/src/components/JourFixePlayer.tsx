import { useEffect, useRef, useState } from "react";
import { OptionSelect } from "./ui/option-select";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
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
  // Der gewünschte Abspielwunsch überlebt den Neuaufbau, sobald der Ton da ist.
  const [pendingPlay, setPendingPlay] = useState(false);
  return (
    <PlayerContent
      key={props.source ?? "unavailable"}
      {...props}
      pendingPlay={pendingPlay}
      onPendingPlayChange={setPendingPlay}
    />
  );
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
  pendingPlay,
  onPendingPlayChange,
}: JourFixePlayerProps & {
  readonly pendingPlay: boolean;
  readonly onPendingPlayChange: (pending: boolean) => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(rate);
  const [failed, setFailed] = useState(false);
  const playable = source?.startsWith("blob:") === true && !failed;
  const waitingForAudio = pendingPlay && !playable && !failed;
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
    // Ein Klick auf Play ohne geladenen Ton startet, sobald der Ton da ist.
    if (!pendingPlay || !playable) return;
    onPendingPlayChange(false);
    void togglePlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlay, playable]);
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = () => void pressPlay();
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
  function pressPlay() {
    if (failed) return;
    if (playable) void togglePlayback();
    else onPendingPlayChange(true);
  }
  function changeSlide(action: () => void) {
    audio.current?.pause();
    action();
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Folienplayer">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Vorherige Folie"
          disabled={!hasPrevious}
          onClick={() => changeSlide(onPrevious)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label={
            waitingForAudio
              ? "Ton wird geladen"
              : playing
                ? "Sprecher pausieren"
                : "Sprecher abspielen"
          }
          aria-busy={waitingForAudio}
          disabled={failed}
          onClick={pressPlay}
        >
          {waitingForAudio ? (
            <Loader2Icon className="animate-spin" />
          ) : playing ? (
            <PauseIcon />
          ) : (
            <PlayIcon />
          )}
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Nächste Folie"
          disabled={!hasNext}
          onClick={() => changeSlide(onNext)}
        >
          <ChevronRightIcon />
        </Button>
        <input
          type="range"
          aria-label="Sprecherfortschritt"
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
        {/* Without audio there is no time to show (Audit A-54). */}
        {duration > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {timestamp(position)} / {timestamp(duration)}
          </span>
        ) : null}
        <OptionSelect
          aria-label="Wiedergabetempo"
          className="w-auto min-w-0"
          value={String(speed)}
          options={[...new Set([0.8, 1, 1.15, 1.25, 1.5, rate])]
            .sort((a, b) => a - b)
            .map((option) => ({
              value: String(option),
              label: `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(option)}×`,
            }))}
          onValueChange={(next) => {
            const nextRate = Number(next);
            if (audio.current) {
              audio.current.preservesPitch = true;
              audio.current.playbackRate = nextRate;
            }
            setSpeed(nextRate);
          }}
        />
        {onAutoAdvanceChange && (
          <Button
            size="sm"
            variant={autoAdvance ? "default" : "outline"}
            aria-pressed={autoAdvance}
            title="Automatisch weiter"
            onClick={() => onAutoAdvanceChange(!autoAdvance)}
          >
            Auto
          </Button>
        )}
        {onFullscreen && (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Vollbild"
            title="Vollbild · Folien ← → · Sprecher Leertaste"
            onClick={onFullscreen}
          >
            <Maximize2Icon />
          </Button>
        )}
        {waitingForAudio && (
          <span role="status" className="text-xs text-muted-foreground">
            Ton wird geladen …
          </span>
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
      {failed && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Wiedergabe fehlgeschlagen
        </p>
      )}
    </div>
  );
}
