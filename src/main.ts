// Platzhalter-Einstiegspunkt: hält den Container am Leben, bis Module und Adapter verdrahtet sind.
console.log("HomeFlow gestartet (keine Adapter konfiguriert).");

const keepAlive = setInterval(() => undefined, 1 << 30);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(keepAlive);
    console.log(`HomeFlow beendet (${signal}).`);
  });
}
