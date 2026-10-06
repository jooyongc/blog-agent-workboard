type SchedulerEnv = {
  WORKBOARD_URL: string;
  SCHEDULER_TOKEN: string;
  AGENT_QUEUE: Queue<{ type: string }>;
};
async function invoke(env: SchedulerEnv, path: string) {
  const response = await fetch(
    new URL("/api/internal/" + path, env.WORKBOARD_URL),
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.SCHEDULER_TOKEN,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(600000),
    },
  );
  if (!response.ok)
    throw Error("Workboard " + path + " HTTP " + response.status);
  return response.json() as Promise<{ worked?: boolean; waiting?: boolean }>;
}
export default {
  scheduled(
    _event: ScheduledController,
    env: SchedulerEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      Promise.all([
        env.AGENT_QUEUE.send({ type: "harness" }),
        invoke(env, "scheduler"),
      ]),
    );
  },
  async queue(batch: MessageBatch<{ type: string }>, env: SchedulerEnv) {
    for (const message of batch.messages) {
      try {
        const result = await invoke(env, "harness");
        if (result.worked)
          await env.AGENT_QUEUE.send(
            { type: "harness" },
            { delaySeconds: result.waiting ? 10 : 0 },
          );
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async fetch(request: Request, env: SchedulerEnv) {
    if (new URL(request.url).pathname === "/run") {
      if (
        request.method !== "POST" ||
        request.headers.get("Authorization") !== "Bearer " + env.SCHEDULER_TOKEN
      )
        return new Response("Unauthorized", { status: 401 });
      await env.AGENT_QUEUE.send({ type: "harness" });
      return Response.json(
        { accepted: true, transport: "Cloudflare Queues" },
        { status: 202 },
      );
    }
    return Response.json({
      service: "blog-agent-workboard-scheduler",
      status: "ok",
      transport: "Cloudflare Queues",
      agents: ["researcher", "writer", "photo_editor", "verifier", "supervisor", "editor", "publisher"],
    });
  },
};
