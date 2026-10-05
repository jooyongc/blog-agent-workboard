type SchedulerEnv = { WORKBOARD_URL: string; SCHEDULER_TOKEN: string };
async function run(env: SchedulerEnv) {
  const headers = {
    Authorization: "Bearer " + env.SCHEDULER_TOKEN,
    "Content-Type": "application/json",
  };
  for (let i = 0; i < 20; i++) {
    const r = await fetch(new URL("/api/internal/harness", env.WORKBOARD_URL), {
      method: "POST",
      headers,
      body: "{}",
    });
    if (!r.ok) throw Error("Harness HTTP " + r.status);
    const result = (await r.json()) as { worked: boolean };
    if (!result.worked) break;
  }
  const res = await fetch(
    new URL("/api/internal/scheduler", env.WORKBOARD_URL),
    { method: "POST", headers, body: "{}" },
  );
  if (!res.ok) throw Error("Scheduler HTTP " + res.status);
}
export default {
  scheduled(
    _event: ScheduledController,
    env: SchedulerEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(run(env));
  },
  async fetch(request: Request, env: SchedulerEnv, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/run") {
      if (
        request.method !== "POST" ||
        request.headers.get("Authorization") !== "Bearer " + env.SCHEDULER_TOKEN
      )
        return new Response("Unauthorized", { status: 401 });
      ctx.waitUntil(run(env));
      return Response.json({ accepted: true }, { status: 202 });
    }
    return Response.json({
      service: "blog-agent-workboard-scheduler",
      status: "ok",
      agents: ["researcher", "writer", "photo_editor", "verifier", "publisher"],
    });
  },
};
