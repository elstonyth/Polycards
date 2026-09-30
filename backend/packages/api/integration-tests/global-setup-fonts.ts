import { ensureBundledFonts } from '../src/api/admin/media/label-font';

// jest hands each test file a COPY of process.env (jest-util createProcessEnv),
// so ensureBundledFonts() called from a test sets FONTCONFIG_PATH /
// FONTCONFIG_FILE on that copy only. sharp's native fontconfig reads the real
// environment, so under jest it fell back to the runner's system fonts: Nekst
// and Geist rendered as one face (label-font.unit.spec) while Arimo passed on
// a metric-compatible system alias.
//
// globalSetup runs in the real jest process before any test, so the variables
// set here are the ones fontconfig reads at the first text render (the suites
// run --runInBand in this process; workers would inherit them at spawn).
// Plain node — production — was never affected.
export default function globalSetup(): void {
  ensureBundledFonts();
}
