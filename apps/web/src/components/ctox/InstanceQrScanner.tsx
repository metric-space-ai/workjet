import { useEffect, useRef, useState } from "react";
interface QrDetector {
  detect(source: HTMLVideoElement): Promise<readonly { rawValue: string }[]>;
}
type QrDetectorConstructor = new (options: { formats: string[] }) => QrDetector;

export function InstanceQrScanner({
  onDetected,
}: {
  readonly onDetected: (value: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stopped = false;
    let media: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      media?.getTracks().forEach((track) => track.stop());
    };
    const start = async () => {
      try {
        const Detector = (
          globalThis as typeof globalThis & { BarcodeDetector?: QrDetectorConstructor }
        ).BarcodeDetector;
        if (!Detector || !navigator.mediaDevices?.getUserMedia) {
          setError("Die Kamera kann hier keine QR-Codes lesen. Verwende den Einladungslink.");
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
            if (!stopped)
              setError(
                "Der QR-Code konnte nicht gelesen werden. Verwende den Link oder starte den Scanner erneut.",
              );
            stop();
          }
        };
        void scan();
      } catch {
        if (!stopped)
          setError(
            "Die Kamera ist nicht verfügbar oder der Zugriff wurde abgelehnt. Du kannst stattdessen einen Link eingeben.",
          );
        stop();
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
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {ready ? "Halte den QR-Code der Instanz vor die Kamera." : "Kamera wird gestartet…"}
        </p>
      )}
    </div>
  );
}
