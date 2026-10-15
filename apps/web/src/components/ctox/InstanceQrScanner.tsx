import { useEffect, useRef, useState } from "react";
interface QrDetector {
  detect(source: HTMLVideoElement): Promise<readonly { rawValue: string }[]>;
}
type QrDetectorConstructor = new (options: { formats: string[] }) => QrDetector;

export const QR_CAMERA_UNAVAILABLE = "Kamera nicht verfügbar.";
export const QR_UNREADABLE = "QR-Code nicht lesbar.";
const CAMERA_START_TIMEOUT_MS = 10_000;

export function InstanceQrScanner({
  onDetected,
  onUnavailable,
}: {
  readonly onDetected: (value: string) => void;
  /** Kamera fehlt, verweigert oder liest nicht: der Aufrufer wechselt auf den Link. */
  readonly onUnavailable?: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const [error, setErrorState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stopped = false;
    let media: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    const startTimeout = setTimeout(() => {
      if (!stopped && !started) setError(QR_CAMERA_UNAVAILABLE);
    }, CAMERA_START_TIMEOUT_MS);
    const setError = (message: string) => {
      setErrorState(message);
      onUnavailableRef.current?.(message);
      stop();
    };
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(startTimeout);
      media?.getTracks().forEach((track) => track.stop());
    };
    const start = async () => {
      try {
        const Detector = (
          globalThis as typeof globalThis & { BarcodeDetector?: QrDetectorConstructor }
        ).BarcodeDetector;
        if (!Detector || !navigator.mediaDevices?.getUserMedia) {
          setError(QR_CAMERA_UNAVAILABLE);
          return;
        }
        const detector = new Detector({ formats: ["qr_code"] });
        media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped || !video.current) {
          stop();
          return;
        }
        video.current.srcObject = media;
        await video.current.play();
        if (stopped) return;
        started = true;
        clearTimeout(startTimeout);
        setReady(true);
        const scan = async () => {
          if (stopped || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            if (stopped) return;
            const value = codes.find((code) => code.rawValue.trim() !== "")?.rawValue;
            if (value) {
              stop();
              onDetectedRef.current(value);
              return;
            }
            timer = setTimeout(() => {
              void scan();
            }, 200);
          } catch {
            if (!stopped) setError(QR_UNREADABLE);
          }
        };
        void scan();
      } catch {
        if (stopped) return;
        setError(QR_CAMERA_UNAVAILABLE);
      }
    };
    void start();
    return stop;
  }, []);
  return (
    <div className="space-y-3">
      <video
        ref={video}
        muted
        playsInline
        className="aspect-square max-h-72 w-full rounded-lg bg-black object-cover"
        aria-label="QR-Code Scanner"
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : ready ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          Kamera wird gestartet …
        </p>
      )}
    </div>
  );
}
