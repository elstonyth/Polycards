import { startWorkflowWorkerWatchdog } from './src/utils/workflow-worker-watchdog';

// `medusa start` calls register() once in every process (web and worker),
// before the app loads, so this is the one boot seam that does not depend on
// the scheduled-job worker it watches. Medusa logs "OTEL registered" just
// before calling it; that line means this file ran, not that OpenTelemetry is on.
export function register() {
  startWorkflowWorkerWatchdog();
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
