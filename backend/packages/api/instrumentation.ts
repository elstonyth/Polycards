// `medusa start` calls register() once in every process (web and worker),
// before the app loads, so this is the one boot seam that does not depend on
// the scheduled-job worker it watches. Medusa logs "OTEL registered" just
// before calling it; that line means this file ran, not that OpenTelemetry is on.
export function register() {
  // The web service builds no workflow workers (medusa-config reads the same
  // variable), so there is nothing to watch there.
  if (process.env.MEDUSA_WORKER_MODE === 'server') return;
  // Loaded here, not imported at the top: Medusa runs this outside its boot
  // error handling, so a throw while loading the watchdog must not stop the
  // web service or the worker from starting.
  try {
    const watchdog =
      require('./src/utils/workflow-worker-watchdog') as typeof import('./src/utils/workflow-worker-watchdog');
    watchdog.startWorkflowWorkerWatchdog();
  } catch (error) {
    console.error(
      `[workflow-worker-watchdog] not started: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// To enable OpenTelemetry, add registerOtel to register() above.
// Refer to the docs for installation instructions: https://docs.medusajs.com/learn/debugging-and-testing/instrumentation

// import { registerOtel } from "@medusajs/medusa"
// // If using an exporter other than Zipkin, require it here.
// import { ZipkinExporter } from "@opentelemetry/exporter-zipkin"

// // If using an exporter other than Zipkin, initialize it here.
// const exporter = new ZipkinExporter({
//   serviceName: 'my-medusa-project',
// })

//   registerOtel({
//     serviceName: 'medusajs',
//     // pass exporter
//     exporter,
//     instrument: {
//       http: true,
//       workflows: true,
//       query: true
//     },
//   })
