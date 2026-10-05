type SchedulerEnv = { WORKBOARD_URL: string; SCHEDULER_TOKEN: string };
export default {
  scheduled(
    _event: ScheduledController,
    env: SchedulerEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        const res = await fetch(
          new URL("/api/internal/scheduler", env.WORKBOARD_URL),
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + env.SCHEDULER_TOKEN,
              "Content-Type": "application/json",
            },
            body: "{}",
          },
        );
        if (!res.ok)
          throw Error("Workboard scheduler failed: HTTP " + res.status);
      })(),
    );
  },
  fetch() {
    return new Response(
      JSON.stringify({
        service: "blog-agent-workboard-scheduler",
        status: "ok",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};
