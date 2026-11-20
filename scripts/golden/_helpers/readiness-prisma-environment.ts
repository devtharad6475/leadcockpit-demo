// Imported FIRST by the destructive readiness goldens, before repositories latch.
import "./force-prisma-provider";
import { assertDisposableReadinessDatabase } from "./disposable-readiness-database";
assertDisposableReadinessDatabase(process.env.DATABASE_URL, process.env.CI);
// These proofs exercise local persistence, not real account email delivery.
process.env.RESEND_API_KEY = "";
