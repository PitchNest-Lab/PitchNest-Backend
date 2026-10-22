/**
 * Holds a reply until a minimum time has passed since the handler started.
 *
 * Signup, resend-verification and forgot-password give every outcome the same
 * reply, so the reply cannot show whether an address has an account. They now
 * also wait for the email to be accepted before replying (on Lambda nothing
 * runs after the reply is sent), so the outcomes that send an email are slower.
 * Calling the returned function before every reply makes the outcomes that
 * send nothing wait as long, so the timing gives nothing away either.
 *
 * A branch that already took longer than the floor is not delayed further.
 */
let floorMs = 1_500;

export function startResponseFloor(): () => Promise<void> {
  const startedAt = Date.now();
  return async () => {
    const remaining = floorMs - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  };
}

/** Test-only: shorten the floor so the suite stays fast. Refuses outside NODE_ENV=test. */
export function __setResponseFloorForTests(ms: number): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setResponseFloorForTests is only available when NODE_ENV=test");
  }
  floorMs = ms;
}
